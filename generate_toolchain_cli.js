const _ = require("lodash");
const fs = require("fs");
const nconf = require("nconf");
const { exec } = require("child_process");
const { getBearerToken } = require("./lib/clients/iam-client");
const { getServices } = require("./lib/clients/toolchain-client");

nconf.env("__");
if (process.env.NODE_ENV === "local") {
    nconf.file("local", "./config/local.json");
}
nconf.file("defaults", "./config/defaults.json");

const GREEN = "\x1b[32m";
const NC = "\x1b[0m";

const ALLOWED_PARAMETER_TYPES = nconf.get("ALLOWED_PARAMETER_TYPES");
const EXCLUDED_SERVICES = nconf.get("EXCLUDED_SERVICES");
const HARDCODED_SERVICE_PARAMETERS = nconf.get("HARDCODED_SERVICE_PARAMETERS");

const TARGET_DIRECTORY = process.argv[2];
const SWAGGER_PATH = process.argv[3];

const main = async () => {
    try {
        // Expand swagger from the otc-api swagger
        log("Expanding swagger from otc-api to ./swagger/openapi.json", null, true);
        execute(`swagger-codegen generate -l openapi -i ${SWAGGER_PATH} -o ./swagger`);
        await wait(3); // Give enough time for changes to appear in system
        const swagger = JSON.parse(fs.readFileSync("./swagger/openapi.json"));

        // Inject a POST and PATCH endpoint for each tool
        log("Getting services metadata from catalog");
        const token = await getBearerToken();
        const services = await getServices(token);
        const resources = Object.values(services.resources);

        // Base path
        const toolsPath = "/toolchains/{toolchain_id}/tools";
        const toolsByIdPath = "/toolchains/{toolchain_id}/tools/{tool_id}";

        // Maps to quickly jump between different formats for the names of each service and their parameters
        const cliToBrokerParameterMap = {}; // ex: { appconfig: { instance-id (CLI) -> instance_id (broker) } }
        const goToBrokerParameterMap = {}; // ex: { Appconfig: { ResourceGroupName (go) -> resource-group (broker) } }
        const serviceNameToToolTypeIdMap = {}; // ex: { PrivateWorker (go) -> private_worker (tool_type_id) }

        // Track which services have parameters
        const servicesWithParameters = [];

        resources.forEach((resource, i) => {
            // if (i != 0) return;
            // Generic info about service
            const displayName = resource.metadata.displayName;
            const serviceName = resource.entity.unique_id;
            const formattedServiceName = formatAsCamelCase(serviceName);

            // Parameter-specfic info
            const propertiesMap = resource.metadata.parameters?.properties || {};
            const required = resource.metadata.parameters?.required || [];

            if (EXCLUDED_SERVICES.includes(serviceName)) {
                log(`Skipping service: ${serviceName}`);
                return;
            } else {
                log(`Processing service: ${serviceName}`, null, true);
            }

            cliToBrokerParameterMap[serviceName] = {};
            goToBrokerParameterMap[formattedServiceName] = {};
            serviceNameToToolTypeIdMap[formattedServiceName] = serviceName;

            // Form POST/PATCH body based on service parameters
            const propertyKeys = Object.keys(propertiesMap);
            const propertiesSchema = {};
            const requiredSchema = [];
            propertyKeys.forEach((key) => {
                const property = propertiesMap[key];
                const cliName = getCliParameterName(property.terraform_alias || key);

                if (property["x-terraform-exclude"] || property["x-terraform-computed"] || !ALLOWED_PARAMETER_TYPES.includes(property.type)) {
                    log(`Skipping parameter: ${key}`);
                    return;
                }

                const propertySchema = {
                    type: property.type == "password" ? "string" : property.type,
                    description: property.api_description || property.description || property.title,
                    "x-cli-option-name": cliName, // Explictly define the option name instead of relying on generator
                    ...(property.example && { example: property.example }),
                    ...(property.default && { default: property.default }),
                    ...(property.enum && { enum: property.enum }),
                };

                if (required.includes(key)) {
                    requiredSchema.push(cliName);
                }

                propertiesSchema[cliName] = propertySchema;
                cliToBrokerParameterMap[serviceName][cliName] = key;
                goToBrokerParameterMap[formattedServiceName][formatAsCamelCase(property.terraform_alias || key)] = key;
            });

            const bodySchema = {
                type: "object",
                properties: propertiesSchema,
                additionalProperties: false,
            };

            if (Object.keys(propertiesSchema).length > 0) {
                servicesWithParameters.push(serviceName);
            }

            // Create POST schema
            const post = _.cloneDeep(swagger.paths[toolsPath].post); // Need 'cloneDeep', otherwise causes random issues during CLI generation
            post.summary = `Create a ${displayName} tool`;
            post.description = `Provisions a new ${displayName} tool based off the provided parameters in the body and binds it to the specified toolchain`;
            post.operationId = `create_${serviceName}`;
            if (propertyKeys.length > 0) {
                post.requestBody.content["application/json"].schema = {
                    ...bodySchema,
                    ...(requiredSchema.length > 0 && { required: requiredSchema }),
                };
            } else {
                delete post.requestBody;
            }

            // Create PATCH schema
            const patch = _.cloneDeep(swagger.paths[toolsByIdPath].patch); // Need 'cloneDeep', otherwise causes random issues during CLI generation
            patch.summary = `Update a ${displayName} tool`;
            patch.description = `Update the ${displayName} tool with the specified ID`;
            patch.operationId = `update_${serviceName}`;
            delete patch.requestBody.content["application/merge-patch+json"]; // Need 'application/json', otherwise affects what gets generated
            if (propertyKeys.length > 0) {
                patch.requestBody.content["application/json"] = { schema: bodySchema };
            } else {
                delete patch.requestBody;
            }

            // Inject into swagger
            swagger.paths[`${toolsPath}/${serviceName}`] = { post: _.cloneDeep(post) };
            swagger.paths[`${toolsPath}/${serviceName}/{tool_id}`] = { patch: _.cloneDeep(patch) };

            log(`Properties in schema: ${JSON.stringify(Object.keys(propertiesSchema))}`);
        });

        // We don't need 'create-tool' and 'update-tool' commands
        delete swagger.paths[toolsPath].post;
        delete swagger.paths[toolsByIdPath].patch;

        log("Writing modified OpenAPI to ./swagger/swagger.json");
        fs.writeFileSync("./swagger/swagger.json", JSON.stringify(swagger, null, 2));

        log(`Generating CLI using modified OpenAPI, result in: ${TARGET_DIRECTORY}`, null, true);
        execute(`openapi-sdkgen.sh generate -g cli -i ./swagger/swagger.json -o ${TARGET_DIRECTORY} --additional-properties initialize=true`);

        await wait(3); // Give enough time for changes to appear in system

        // These files need modifications
        const goCommandsFileDir = `${TARGET_DIRECTORY}/plugin/commands/cdtoolchainv2/commands.go`;
        const mockSendersTestFileDir = `${TARGET_DIRECTORY}/plugin/commands/cdtoolchainv2/mock_senders_for_test.go`;
        const mainTestFileDir = `${TARGET_DIRECTORY}/main_test.go`;

        const goCommandsFile = readFileAsArray(goCommandsFileDir);
        const mockSendersTestFile = readFileAsArray(mockSendersTestFileDir);
        const mainTestFile = readFileAsArray(mainTestFileDir);

        processCommandsFile(goCommandsFile, resources, servicesWithParameters, cliToBrokerParameterMap, serviceNameToToolTypeIdMap);
        processMockSendersTestFile(mockSendersTestFile, resources, goToBrokerParameterMap, servicesWithParameters, serviceNameToToolTypeIdMap);
        processMainTestFile(mainTestFile, resources);

        writeArrayToFile(goCommandsFile, goCommandsFileDir);
        writeArrayToFile(mockSendersTestFile, mockSendersTestFileDir);
        writeArrayToFile(mainTestFile, mainTestFileDir);
    } catch (err) {
        console.error(`${err.message}${err.response?.data ? `: ${JSON.stringify(err.response?.data, null, 2)}` : ""}`);
        process.exit(1);
    }
};

const processCommandsFile = (file, resources, servicesWithParameters, cliToBrokerParameterMap, serviceNameToToolTypeIdMap) => {
    // The generated command.go file needs to be modified to point to the POST /tools endpoint for each service create/update command
    const fnKeywords = [];
    const wordsToReplace = {};

    resources.forEach((resource) => {
        if (EXCLUDED_SERVICES.includes(resource.entity.unique_id)) {
            return;
        }

        const serviceName = formatAsCamelCase(resource.entity.unique_id);

        wordsToReplace[`ServiceInstance.Create${serviceName}`] = "ServiceInstance.CreateTool";
        wordsToReplace[`ServiceInstance.Update${serviceName}`] = "ServiceInstance.UpdateTool";
        wordsToReplace[`cdtoolchainv2.Create${serviceName}Options`] = "cdtoolchainv2.CreateToolOptions";
        wordsToReplace[`cdtoolchainv2.Update${serviceName}Options`] = "cdtoolchainv2.UpdateToolOptions";

        fnKeywords.push(`Create${serviceName}CommandRunner) Run`);
        fnKeywords.push(`Update${serviceName}CommandRunner) Run`);
    });

    // Check the file line by line and make amends as needed
    log(`Making modifications to ${TARGET_DIRECTORY}/plugin/commands/cdtoolchainv2/commands.go`, null, true);
    const wordsToReplaceKeys = Object.keys(wordsToReplace);
    for (let i = 0; i < file.length; i++) {
        let line = file[i];

        fnKeywords.forEach((keyword) => {
            if (!line.includes(keyword)) return;
            log(`Found function '... ${keyword} ...', making changes to the function`, i + 1);

            const createCommand = keyword.includes("Create");
            const updateCommand = keyword.includes("Update");

            // Get the camel-case service name
            const serviceName = keyword.match(/(Create|Update)([a-zA-Z]+)CommandRunner/)?.[2];
            const toolTypeId = serviceNameToToolTypeIdMap[serviceName];

            const hasParameters = servicesWithParameters.includes(toolTypeId);

            let insideFlagsBlock = false;

            for (let j = i + 1; j < file.length; j++) {
                let fn = file[j];

                if (!insideFlagsBlock && fn.includes("FlagSet := cmd.Flags()")) {
                    // Right before the flags block
                    // Initialize 'Parameters' map to store parameters
                    insideFlagsBlock = true;
                    const linesToAdd = [];
                    if (hasParameters) {
                        linesToAdd.push("\tparameters := map[string]interface{}{}");
                    }
                    if (updateCommand) {
                        if (hasParameters) {
                            linesToAdd.push("\ttoolPrototypePatch := map[string]interface{}{");
                            linesToAdd.push('\t\t"parameters": &parameters,');
                            linesToAdd.push("\t}");
                        } else {
                            // Even without parameters, an empty map should be passed
                            linesToAdd.push("\ttoolPrototypePatch := map[string]interface{}{}");
                        }
                    }
                    if (linesToAdd.length > 0) {
                        file.splice(j + 1, 0, ...linesToAdd);
                    }
                } else if (insideFlagsBlock && fn.includes("r.MakeRequest(OptionsModel)")) {
                    // At the end of the function after the flags block
                    const linesToAdd = [];
                    if (HARDCODED_SERVICE_PARAMETERS[toolTypeId]) {
                        Object.keys(HARDCODED_SERVICE_PARAMETERS[toolTypeId]).forEach((param) => {
                            const harcodedValue = HARDCODED_SERVICE_PARAMETERS[toolTypeId][param];
                            linesToAdd.push(`\tparameters["${param}"] = "${harcodedValue}"`);
                        });
                    }
                    if (createCommand) {
                        linesToAdd.push(`\tOptionsModel.SetToolTypeID("${toolTypeId}")`);
                        if (hasParameters) {
                            linesToAdd.push("\tOptionsModel.SetParameters(parameters)");
                        }
                    }
                    if (updateCommand) {
                        linesToAdd.push("\tOptionsModel.SetToolchainToolPrototypePatch(toolPrototypePatch)");
                    }
                    file.splice(j, 0, ...linesToAdd);
                    return;
                } else if (insideFlagsBlock && hasParameters) {
                    // Within the flags block
                    // Replace each Set command to save value into Parameters map, except for ToolchainID and ToolID
                    if (fn.includes("OptionsModel.Set") && !fn.includes("ToolchainID") && !fn.includes("ToolID")) {
                        // Get property name from previous line
                        const property = file[j - 1].match(/if flag.Name == "([-a-z]+)"/)?.[1];
                        // Get the value to place in the map (ex: r.Name -> Name)
                        const value = fn.match(/r\.([a-zA-Z]+)/)?.[1];
                        file[j] = fn.replace(/OptionsModel.Set.*/, `parameters["${cliToBrokerParameterMap[toolTypeId][property]}"] = r.${value}`);
                    }
                }
            }
        });

        wordsToReplaceKeys.forEach((word) => {
            if (line.includes(word)) {
                // Use file[i].replace instead of line, as the same line sometimes gets updated twice
                file[i] = file[i].replace(word, wordsToReplace[word]);
                log(`Replaced '${word}' with '${wordsToReplace[word]}'`, i + 1);
            }
        });
    }
};

const processMockSendersTestFile = (file, resources, goToBrokerParameterMap, servicesWithParameters, serviceNameToToolTypeIdMap) => {
    // The generated mock_senders_for_test.go file needs to be modified to read the 'Parameters' property under CreateToolOptions and
    // the 'ToolchainToolPrototypePatch' property under UpdateToolOptions
    const fnKeywords = [];
    const wordsToReplace = {};
    resources.forEach((resource) => {
        if (EXCLUDED_SERVICES.includes(resource.entity.unique_id)) {
            return;
        }

        const serviceName = formatAsCamelCase(resource.entity.unique_id);

        wordsToReplace[`cdtoolchainv2.Create${serviceName}Options`] = "cdtoolchainv2.CreateToolOptions";
        wordsToReplace[`cdtoolchainv2.Update${serviceName}Options`] = "cdtoolchainv2.UpdateToolOptions";

        fnKeywords.push(`Create${serviceName}MockSender) Send`);
        fnKeywords.push(`Update${serviceName}MockSender) Send`);
    });

    // Check the file line by line and make amends as needed
    log(`Making modifications to ${TARGET_DIRECTORY}/plugin/commands/cdtoolchainv2/mock_senders_for_test.go`, null, true);
    const wordsToReplaceKeys = Object.keys(wordsToReplace);

    for (let i = 0; i < file.length; i++) {
        let line = file[i];

        fnKeywords.forEach((keyword) => {
            if (!line.includes(keyword)) return;
            log(`Found function '... ${keyword} ...', making changes to the function`, i + 1);

            const createTest = keyword.includes("Create");
            const updateTest = keyword.includes("Update");

            // Get the camel-case service name
            const serviceName = keyword.match(/(Create|Update)([a-zA-Z]+)MockSender/)?.[2];
            let withinAssertBlock = false;

            const hasParameters = servicesWithParameters.includes(serviceNameToToolTypeIdMap[serviceName]);

            for (let j = i + 1; j < file.length; j++) {
                let fn = file[j];
                if (!withinAssertBlock) {
                    if (fn.includes("Expect(createdOptions")) {
                        withinAssertBlock = true;
                        if (updateTest && hasParameters) {
                            file.splice(j, 0, '\ttp := createdOptions.ToolchainToolPrototypePatch["parameters"].(*map[string]interface{})');
                        }
                    } else {
                        continue;
                    }
                }

                if (fn.includes("ToolchainID") || fn.includes("ToolID")) continue;
                if (!fn.includes("Expect")) return;

                const property = fn.match(/Expect\(createdOptions.([a-zA-Z]+)\)/)?.[1];
                const assertValue = fn.match(/core.(String|Bool)Ptr\((.*)\)\)\)/)?.[2];
                const brokerProperty = goToBrokerParameterMap[serviceName][property];
                const sourceMap = createTest ? "createdOptions.Parameters" : updateTest ? "(*tp)" : "";
                file[j] = fn.replace(/Expect.*/, `Expect(${sourceMap}["${brokerProperty}"]).To(Equal(${assertValue}))`);
            }
        });

        wordsToReplaceKeys.forEach((word) => {
            if (line.includes(word)) {
                file[i] = line.replace(word, wordsToReplace[word]);
                log(`Replaced '${word}' with '${wordsToReplace[word]}'`, i + 1);
            }
        });
    }
};

const processMainTestFile = (file, resources) => {
    // The generated main_test.go file needs to be modified to change the 'operationPath' for each tool
    const wordsToReplace = {};
    resources.forEach((resource) => {
        if (EXCLUDED_SERVICES.includes(resource.entity.unique_id)) {
            return;
        }

        const serviceName = resource.entity.unique_id;

        wordsToReplace[`/toolchains/testString/tools/${serviceName}`] = "/toolchains/testString/tools";
        wordsToReplace[`/toolchains/testString/tools/${serviceName}/testString`] = "/toolchains/testString/tools/testString";
    });

    // Check the file line by line and make amends as needed
    log(`Making modifications to ${TARGET_DIRECTORY}/main_test.go`, null, true);
    const wordsToReplaceKeys = Object.keys(wordsToReplace);
    for (let i = 0; i < file.length; i++) {
        let line = file[i];

        wordsToReplaceKeys.forEach((word) => {
            if (line.includes(word)) {
                file[i] = line.replace(word, wordsToReplace[word]);
                log(`Replaced '${word}' with '${wordsToReplace[word]}'`, i + 1);
            }
        });
    }
};

// ############
// Utils
// ############

const formatAsCamelCase = (word) => {
    let res = "";
    const words = word.split(/[_-]+|(?=[A-Z])+/);
    words.forEach((part) => {
        const lowercase = part.toLowerCase();
        if (["id", "url", "crn", "api"].includes(lowercase)) {
            res += part.toUpperCase();
        } else {
            res += part.charAt(0).toUpperCase() + part.slice(1);
        }
    });
    return res;
};

const getCliParameterName = (parameter) => {
    // Any '_' should be replaced with '-' (ex: toolchain_id -> toolchain-id)
    // Any uppercase letters should be converted to lowercase and separated with '-' (ex: workerQueueCredentials -> worker-queue-credentials)
    if (parameter.includes("_")) {
        return parameter.replaceAll("_", "-");
    } else {
        let cliParam = "";
        for (let i = 0; i < parameter.length; i++) {
            const char = parameter.charAt(i);
            if (char >= "A" && char <= "Z") {
                cliParam += `-${String.fromCharCode(char.charCodeAt() + 32)}`;
            } else {
                cliParam += char;
            }
        }
        return cliParam;
    }
};

const execute = (command) => {
    const child = exec(command);
    child.stdout.pipe(process.stdout);
    child.on('exit', () => console.log(''));
};

const wait = async (seconds) => {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

const log = (line, lineNumber, sectionHeader = false) => {
    const prefix = `[${new Date().toISOString()}] `;
    let message = "";
    if (lineNumber) {
        message += `[Line #${lineNumber}]\t`;
    }
    message += line;
    console.log(`${sectionHeader? `\n${GREEN}` : ""}${prefix}${message}${NC}`);
    if (sectionHeader) {
        log(`${GREEN}${"-".repeat(message.length)}${NC}`);
    }
};

const readFileAsArray = (sourceFile) => {
    return fs.readFileSync(sourceFile).toString().split("\n");
};

const writeArrayToFile = (array, destinationFile) => {
    log(`Overwriting file: ${destinationFile}`);
    const file = fs.createWriteStream(destinationFile);
    file.on("error", (err) => {
        throw err;
    });
    array.forEach((v) => file.write(v + "\n"));
    file.end();
};

main();
