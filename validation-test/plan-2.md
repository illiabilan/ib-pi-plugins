# Feature Implementation Specification

## Context
We need a farewell message generator

## Target File
Create file at: `./validation-test/farewells.js`

## Function Requirements

Name: `sayGoodbye`
Input parameter: `person` (string type)
Output: string formatted as "Goodbye, [person]!"

Special cases:
- When person parameter is absent (undefined/null): output "Goodbye, friend!"
- When person parameter is empty string: output "Goodbye, friend!"
- When person parameter is not a string type: throw TypeError with message "Person must be a string"

## Code Style Requirements
Follow existing module patterns:
- Use camelCase for function names
- Use module.exports for exporting
- Use template literals for string formatting
- Throw TypeError for type validation, following existing error message format

## Success Criteria
1. File created at specified location
2. Function matches signature and behavior described
3. Follows existing code patterns in sample-utils.js
4. Passes syntax validation (node -c)
