VERSION := "0.6.0"

generate:
    ./generate.sh

release:
    jq --arg v "{{VERSION}}" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
