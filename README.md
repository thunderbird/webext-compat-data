Overview
========

This repository provides the Thunderbird WebExtension compatibility data. The long
term goal is to add this data to the [browser-compat-data](https://github.com/mdn/browser-compat-data)
repository (a.k.a. BCD).

The following files are provided:
- `thunderbird_mailextensions.json` : The webextension data from BCD, but with
   additional entries for Thunderbird, including Thunderbird's MailExtension APIs.
- `generate_compat_data.js` : The script to generate the additional compat data for
   Thunderbird.

NPM package
===========

We provide an npm package, which can be used as a drop-in replacement for the BCD module:

``` javascript
// With CommonJS
const bcd = require('@thunderbirdops/webext-compat-data');

// -or-

// With ESM
import thunderbird_compat_data from '@thunderbirdops/webext-compat-data';
```  

Work in progress - missing features
===================================

The compatibility data does not yet contain actual version numbers, but mostly just
`true` or `false` for the `version_added` property. This is being worked on.

We aim to provide this data through an npm package in the future.

The `manifest` data still needs work.

How to contribute
=================

If you find an error in the provided compatibility data, we suggest to always file
an issue.

Since the data is mostly generated, the actual error is probably one of the following: 
* the generator script is doing something wrong
* our schema files are wrong or incomplete
* an API claims to be supported but is unknowingly broken due to an implementation
  issue

The project uses the `override.json` file to manually update the generated output,
which is usable for short-term fixes.

We happily accept pull requests to update the override file and the generator script.
We cannot accept pull requests to modify the generated data itself, since it will
be overwritten with each execution of the generator script.

Manually generate the data
==========================

Install needed packages
-----------------------

```
npm install
```

Usage
-----

```
node generate_compat_data.js <options>
```
    
Required options
----------------
```
   --source=path            - Path to a local checkout of a mozilla source
                              repository with a matching /comm directory.
```

Optional options
----------------
```
   --no-mailextensions      - Do not add (Thunderbird-only) MailExtensions APIs.
   --no-minimize            - Do not minimize compat data by excluding properties
                              which have the same compat data as their parent
                              parameter.
   --override=path          - Path to a JSON file with compat data, which should
                              be enforced (for example to mark a toolkit API only
                              partially compatible). The applicable entries of
                              that data are printed to the console.
   --verbosity=level        - Integer representing a selection (sum) of the
                              requested log entries: 
                                1: namespace definitions after $imports
                                2: list all entries found in the schema files
                                4: be verbose while updating the cloned BCD data
```
