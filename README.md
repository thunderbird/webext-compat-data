# webext-compat-data
Thunderbird WebExtension compat data

# How to contribute

If you find an error in the provided compat data, we suggest to always file an issue.

Since the data is mostly generated, the actual error is probably one of the following: 
* the generator script is doing something wrong
* our schema files are wrong or incomplete
* an API claims to be supported but is unknowingly broken due to an implementation
  issue

The project uses the `override.json` file to manually update the generated output,
which is usable for short-term fixes.

We happily accept pull requests to update the override file and the generator script.
We cannot accept pull requests to modify the generated data itself.