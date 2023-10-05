# Continuous Delivery CLI Generator

Note: this is still under development! Feedback is appreciated.

To use the generator, setup the following:
1. Under `./config`, create a `local.json` file and copy the contents of `local.template.json`. Fill in the values.
2. Run `npm install`
3. Run `bash create_cd_cli.sh ${target_directory}`, where `target_directory` is a path where you want the CLI files to be generated. The CLI files will be generated in the target directory, under the folder `cd-cli`.
   Example: `bash create_cd_cli.sh "/Users/omar.albastami/Documents/GitHub/testing-repo"`

To test out the commands:
1. Navigate to the `cd-cli` folder.
2. Using a terminal, run `go run main.go <command>`
   Example: 
   ```
   omar.albastami@Omars-MacBook-Pro cd-cli % go run main.go -h
    NAME:
    continuous-delivery - Commands to manage continuous-delivery.

    USAGE:
    ibmcloud continuous-delivery [command] [options]

    COMMANDS:
    cd-toolchain, ct   Manage CD Toolchain.

    OPTIONS:
    -h, --help      Show help
    -v, --version   version for continuous-delivery

    Use "ibmcloud continuous-delivery service-command --help" for more information about a command.
   ```