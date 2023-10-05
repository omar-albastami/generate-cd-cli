TARGET_DIR="$1"

if ! [[ -d "$TARGET_DIR" ]]; then
    echo "Target directory ${TARGET_DIR} does not exist. Please provide a valid path"
    exit 0
fi

export NODE_ENV=local
CLI_DIR="${TARGET_DIR}/cd-cli"
rm -rf ${CLI_DIR}

git clone --single-branch -b master "https://github.ibm.com/org-ids/otc-api"
SWAGGER_PATH="$(pwd)/otc-api/spec/swagger_v2.json"

git clone "https://github.ibm.com/CloudEngineering/cli-plugin-template" ${CLI_DIR}
node ./generate_toolchain_cli.js ${CLI_DIR} ${SWAGGER_PATH}

rm -rf otc-api
rm -rf swagger

cd ${CLI_DIR}
source ./prepare_project.sh -p cli-continuous-delivery-plugin -n continuous-delivery -t \"Continuous Delivery\"
source ./scripts/prepare-translations.sh

rm -rf .swagger-codegen
rm README.md

go get -u
go build main.go
go test ./...