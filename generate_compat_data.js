#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Author: John Bieling
 * Version: 1.0 (28.06.2024)
 *
 * Features:
 *  - clone the existing browser-compat-data as a starting point
 *  - read and parse all schema files
 *  - handle $imports and $refs (recursive refs are ignored)
 *  - update compat data based on the schema files, trust re-used firefox
 *    schemas as fully supported
 *  - use an override file to manually change/enrich compat data
 *  - auto-remove sub-entries if they all have the same compat data as the parent
 *  - handle unsupported
 *  - handle different notations and log all unexpected entries
 *
 * TODO:
 *  [ ]: Instead of excluding files, add the APIs to the override file, to be
 *       able to add comments.
 *  [ ] Programmatically extract the correct version_added value
 *  [ ] Do not add parents of non-nested properties
 *  [ ] handle deprecated
 *  [ ] handle manifests
 * 
 * Note: There are 4 different notation for parameter properties:
 *  - flatting (tabs.create(), tabs.executeScript(), https://github.com/mdn/browser-compat-data/blob/7afd5da3bfe0e0f4434585ee75f277d784662caf/webextensions/api/tabs.json#L2002)
 *  - paramName_propName_parameter (browserAction.getBadgeBackgroundColor(), https://github.com/mdn/browser-compat-data/blob/7afd5da3bfe0e0f4434585ee75f277d784662caf/webextensions/api/browserAction.json#L138)
 *  - propName_value (tabs.update, https://github.com/mdn/browser-compat-data/blob/7afd5da3bfe0e0f4434585ee75f277d784662caf/webextensions/api/tabs.json#L3966)
 *  - nesting (windows.create(), https://github.com/mdn/browser-compat-data/blob/7afd5da3bfe0e0f4434585ee75f277d784662caf/webextensions/api/windows.json#L699)
 *
 * Issues filed:
 *  - (browser)action.functions.setIcon.parameters (https://github.com/mdn/browser-compat-data/pull/23543)
 *  - tabs.update has tabId as first parameter and updateProperties is using propName_value notation (https://github.com/mdn/browser-compat-data/pull/23544)
 */

const path = require("path");
const fs = require("fs-extra");
const yargs = require("yargs");
const jsonUtils = require("comment-json");
const bcd = require("@mdn/browser-compat-data");

// Note: Using a positive-confirm list and a known-false-positive list to have
// control over the parameter entries which are accepted in flat property notation.
// It should be a goal to remove all usages of the flat property notation in BCD.
const CONFIRMED_FLAT_PROPS = [
  "action.functions.setIcon.parameters.details.properties.imageData",
  "browserAction.functions.setIcon.parameters.details.properties.imageData",
  "commands.functions.update.parameters.detail.properties.",
  "menus.functions.create.parameters.createProperties.properties.",
  "tabs.functions.create.parameters.createProperties.properties.",
  "tabs.functions.executeScript.parameters.details.properties.",
  "tabs.functions.insertCSS.parameters.details.properties.",
  "windows.functions.update.parameters.updateInfo.properties.",
  "windows.functions.getAll.parameters.getInfo.properties.",
];

const KNOWN_FALSE_POSITIVE_FLAT_PROPS = [
  "bookmarks.functions.search.parameters.query.properties.query",
  "topSites.types.MostVisitedURL.properties.type.enum.url",
  "bookmarks.events.onCreated.parameters.bookmark.properties.id",
  "bookmarks.events.onRemoved.parameters.removeInfo.properties.node.properties.",
  "menus.types.OnShowData.properties.selectedAccount.properties.rootFolder.properties.",
  "menus.types.OnClickData.properties.selectedAccount.properties.rootFolder.properties.",
  "menus.events.onShown.parameters.info.properties.selectedAccount.properties.rootFolder.properties.",
  "menus.events.onClicked.parameters.info.properties.selectedAccount.properties.rootFolder.properties.",
  "menus.functions.update.parameters.updateProperties.properties.onclick.parameters.info.properties.selectedAccount.properties.rootFolder.properties.",
  "menus.functions.create.parameters.createProperties.properties.onclick.parameters.info.properties.selectedAccount.properties.rootFolder.properties.",
];

const SKIP_BROWSER_SCHEMAS = ["normandyAddonStudy.json"];
const SKIP_TOOLKIT_SCHEMAS = [
  // Privileged extensions only.
  "activity_log.json",
  "geckoProfiler.json",
  "network_status.json",
  "telemetry.json",
  // Not usable by extensions.
  "test.json",
];

const SUPPORTED_BROWSER_NAMESPACES = ["pkcs11"];
const REIMPLEMENTED_BROWSER_NAMESPACES = [
  "commands",
  "menus",
  "sessions",
  "tabs",
  "windows",
];

const UNSUPPORTED_TOOLKIT_NAMESPACES = [
  "pageAction",
  "captivePortal",
  "proxy", // Bug 1903727.
];
const REIMPLEMENTED_TOOLKIT_NAMESPACES = ["action", "browserAction", "theme"];

const HELP_SCREEN = `
Usage:

    node generate_compat_data.js <options>
    
Required options:
   --source=path            - Path to a local checkout of a mozilla source
                              repository with a matching /comm directory.

Optional options:
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

`;

const args = yargs.argv;
const VERBOSITY = args.verbosity ? parseInt(args.verbosity, 10) : 0;
const MINIMIZE = args.minimize ?? true;
const INCLUDE_MAILEXTENSIONS = args.mailextensions ?? true;

if (!args.source) {
  console.log(HELP_SCREEN);
} else {
  main();
}

// -----------------------------------------------------------------------------

async function main() {
  const tcd = { webextensions: { api: {} } };

  // Read override compat data.
  let override;
  if (args.override && fs.existsSync(args.override)) {
    override = jsonUtils.parse(fs.readFileSync(args.override, "utf-8"));
  }

  // Read the relevant toolkit schema files, excluding internal API's.
  const toolkit_namespaces = readSchemaFiles(
    getJsonFiles(
      path.join(args.source, "toolkit", "components", "extensions", "schemas")
    ).filter(e => !SKIP_TOOLKIT_SCHEMAS.includes(e.name))
  );

  // Read the browser schema files.
  const browser_namespaces = readSchemaFiles(
    getJsonFiles(
      path.join(args.source, "browser", "components", "extensions", "schemas")
    ).filter(e => !SKIP_BROWSER_SCHEMAS.includes(e.name))
  );

  // Read Thunderbird's own schema files.
  const mail_namespaces = readSchemaFiles(
    getJsonFiles(
      path.join(
        args.source,
        "comm",
        "mail",
        "components",
        "extensions",
        "schemas"
      )
    )
  );

  processImports(toolkit_namespaces);
  processImports(browser_namespaces);
  processImports(mail_namespaces);

  // Clone browser-compat-data.
  cloneBrowserCompatData(bcd.webextensions, tcd.webextensions);

  const updateCompatDataLogEntries = new Set();

  if (VERBOSITY & 2) {
    console.log("");
    console.log("Scanning schema files in /comm");
    console.log("==============================");
  }
  const mail_entries = new Map();
  for (const namespaceObj of mail_namespaces) {
    const entries = mail_entries.get(namespaceObj.namespace) ?? new Map();
    collectNamespaceEntriesAndResolveRefs(namespaceObj, entries, [
      ...mail_namespaces,
      ...toolkit_namespaces.filter(
        e => !REIMPLEMENTED_TOOLKIT_NAMESPACES.includes(e.namespace)
      ),
    ]);
    mail_entries.set(namespaceObj.namespace, entries);
  }

  if (VERBOSITY & 2) {
    console.log("");
    console.log("Scanning schema files in /toolkit");
    console.log("=================================");
  }
  for (const namespaceObj of toolkit_namespaces) {
    const entries = new Map();
    collectNamespaceEntriesAndResolveRefs(namespaceObj, entries, [
      ...browser_namespaces,
      ...toolkit_namespaces,
    ]);

    const mail_entry = mail_entries.get(namespaceObj.namespace);
    for (const [namespace_entry, value] of entries) {
      let expected;
      if (UNSUPPORTED_TOOLKIT_NAMESPACES.includes(namespaceObj.namespace)) {
        expected = false;
      } else if (
        REIMPLEMENTED_TOOLKIT_NAMESPACES.includes(namespaceObj.namespace)
      ) {
        // Check how Thunderbird reimplemented the namespace.
        expected =
          mail_entry.has(namespace_entry) &&
          !mail_entry.get(namespace_entry).unsupported;
      } else {
        // The data copied from BCD should be fine for APIs which Thunderbird
        // re-uses from mozilla-central. Unexpected differences are provided by
        // the overlay file.
        continue;
      }
      updateCompatData(
        tcd,
        namespace_entry,
        { version_added: expected },
        updateCompatDataLogEntries
      );
    }
  }

  if (VERBOSITY & 2) {
    console.log("");
    console.log("Scanning schema files in /browser");
    console.log("=================================");
  }
  for (const namespaceObj of browser_namespaces) {
    const entries = new Map();
    collectNamespaceEntriesAndResolveRefs(namespaceObj, entries, [
      ...browser_namespaces,
      ...toolkit_namespaces,
    ]);

    const mail_entry = mail_entries.get(namespaceObj.namespace);
    for (const [namespace_entry, value] of entries) {
      let expected;
      if (SUPPORTED_BROWSER_NAMESPACES.includes(namespaceObj.namespace)) {
        // The data copied from BCD should be fine for APIs which Thunderbird
        // cloned from mozilla-central. Unexpected differences are provided by
        // the overlay file.
        continue;
      } else if (
        REIMPLEMENTED_BROWSER_NAMESPACES.includes(namespaceObj.namespace)
      ) {
        // Check how Thunderbird reimplemented the namespace.
        expected =
          mail_entry.has(namespace_entry) &&
          !mail_entry.get(namespace_entry).unsupported;
      } else {
        // All other browser APIs are not supported.
        expected = false;
      }
      updateCompatData(
        tcd,
        namespace_entry,
        { version_added: expected },
        updateCompatDataLogEntries
      );
    }
  }

  // Check Thunderbird's own data, redo the re-implemented namespaces as well,
  // to check for added elements.
  if (INCLUDE_MAILEXTENSIONS) {
    for (const namespaceObj of mail_namespaces) {
      const entries = mail_entries.get(namespaceObj.namespace);
      const isReimplemented =
        REIMPLEMENTED_TOOLKIT_NAMESPACES.includes(namespaceObj.namespace) ||
        REIMPLEMENTED_BROWSER_NAMESPACES.includes(namespaceObj.namespace);

      for (const [namespace_entry, value] of entries) {
        const expected = !value.unsupported;
        updateCompatData(
          tcd,
          namespace_entry,
          { version_added: expected },
          updateCompatDataLogEntries,
          !isReimplemented
        );
      }
    }
  }

  // Log entries collected in updateCompatData.
  updateCompatDataLogEntries.forEach(e => console.log(e));

  if (override) {
    // Output the actually overridden values, to help minimize the override file.
    console.log(
      JSON.stringify(
        {
          webextensions: overrideBrowserCompatData(
            override.webextensions,
            tcd.webextensions
          ),
        },
        null,
        2
      )
    );
  }

  const browser_compat_data = sortKeys(mergeObjects(bcd, tcd));
  if (MINIMIZE) {
    reduceBrowserCompatData(browser_compat_data.webextensions);
  }

  // Final check, this should not report errors.
  checkForMissingThunderbirdEntries(
    browser_compat_data.webextensions,
    "webextensions"
  );

  // Write modified webextension BCD.
  await writePrettyJSONFile(
    INCLUDE_MAILEXTENSIONS 
      ? "thunderbird_mailextensions.json"
      : "thunderbird_webextensions.json",
    { webextensions: browser_compat_data.webextensions }
  );

  // Write modified webextension BCD (single file per namespace).
  const apiDirectory = INCLUDE_MAILEXTENSIONS
    ? path.join("thunderbird_mailextensions", "api")
    : path.join("thunderbird_webextensions", "api");
  if (!fs.existsSync(apiDirectory)) {
    fs.mkdirSync(apiDirectory, { recursive: true });
  }
  for (const file of await fs.readdir(apiDirectory)) {
    await fs.unlink(path.join(apiDirectory, file));
  }
  for (const namespaceName of Object.keys(
    browser_compat_data.webextensions.api
  )) {
    await writePrettyJSONFile(
      path.join(apiDirectory, `${namespaceName}.json`),
      browser_compat_data.webextensions.api[namespaceName]
    );
  }
}

// -----------------------------------------------------------------------------

// Recursive merge, to is modified.
function mergeObjects(to, from) {
  for (const n in from) {
    if (typeof to[n] != "object") {
      to[n] = from[n];
    } else if (typeof from[n] == "object") {
      to[n] = mergeObjects(to[n], from[n]);
    }
  }
  return to;
}

function sortKeys(x) {
  if (typeof x !== "object" || !x) {
    return x;
  }
  if (Array.isArray(x)) {
    return x.map(sortKeys);
  }
  return Object.keys(x)
    .sort()
    .reduce((o, k) => ({ ...o, [k]: sortKeys(x[k]) }), {});
}

function getJsonFiles(folderPath) {
  return fs
    .readdirSync(folderPath, { withFileTypes: true })
    .filter(
      item =>
        !item.isDirectory() && path.extname(item.name).toLowerCase() === ".json"
    );
}

function readSchemaFiles(files) {
  const schemas = [];
  const namespaces = [{ namespace: "manifest" }];

  for (const file of files) {
    const json = jsonUtils.parse(
      fs.readFileSync(path.join(file.path, file.name), "utf-8")
    );
    schemas.push({
      file,
      json,
    });
  }

  for (const schema of schemas) {
    for (const namespaceObj of schema.json) {
      // Merge manifest namespaces.
      const namespaceName = namespaceObj.namespace;
      if (namespaceName == "manifest") {
        const manifestObj = namespaces[0];
        for (const key of Object.keys(namespaceObj)) {
          if (key == "namespace") {
            continue;
          }
          if (Array.isArray(namespaceObj[key])) {
            if (manifestObj[key]) {
              manifestObj[key].push(...namespaceObj[key]);
            } else {
              manifestObj[key] = [...namespaceObj[key]];
            }
          } else {
            console.error(`Error: ${namespaceName}.${key} cannot be merged`);
          }
        }
        namespaces[0] = manifestObj;
      } else {
        namespaces.push(namespaceObj);
      }
    }
  }
  return namespaces;
}

/**
 * Helper function to produce pretty JSON files.
 *
 * @param {string} path - The path to write the JSON to.
 * @param {obj} json - The obj to write into the file.
 */
async function writePrettyJSONFile(path, json) {
  try {
    return await fs.outputFile(path, JSON.stringify(json, null, 4));
  } catch (err) {
    console.log("Error in writePrettyJSONFile()", path, err);
    throw err;
  }
}

// -----------------------------------------------------------------------------

// Copy "firefox" entries from the BCD data as "thunderbird" entries into the
// TCD data.
function cloneBrowserCompatData(bcdEntry, tcdEntry) {
  if (typeof bcdEntry !== "object" || !bcdEntry) {
    console.error(
      `Error: Should not find an non-object entry in BCD data: ${bcdEntry}`
    );
    return;
  }
  if (Array.isArray(bcdEntry)) {
    console.error(
      `Error: Should not find an array entry in BCD data: ${bcdEntry}`
    );
    return;
  }

  Object.keys(bcdEntry).forEach(k => {
    if (!tcdEntry[k]) {
      tcdEntry[k] = {};
    }
    if (k == "__compat") {
      const version_added =
        bcdEntry[k].support?.firefox?.version_added || false;
      tcdEntry[k] = { support: { thunderbird: { version_added } } };
    } else {
      cloneBrowserCompatData(bcdEntry[k], tcdEntry[k]);
    }
  });
}

// Copy/update "thunderbird" entries from the override data into the TCD data.
function overrideBrowserCompatData(
  overrideEntry,
  tcdEntry,
  parent = "webextensions"
) {
  if (typeof overrideEntry !== "object" || !overrideEntry) {
    console.error(
      `Error: Should not find an non-object entry in BCD data: ${overrideEntry}`
    );
    return undefined;
  }
  if (Array.isArray(overrideEntry)) {
    console.error(
      `Error: Should not find an array entry in BCD data: ${overrideEntry}`
    );
    return undefined;
  }

  let modifiedEntry;
  Object.keys(overrideEntry).forEach(k => {
    if (k == "__compat") {
      const tcd = tcdEntry[k]?.support?.thunderbird;
      const override = overrideEntry[k]?.support?.thunderbird;

      // When not to replace?
      //  - override is empty
      //  - override.version_added is empty
      //  - tcd.version_added is a string and bdc.version_added is true
      //  - no change

      if (
        !(
          !override ||
          typeof override.version_added === "undefined" ||
          tcd?.version_added === override.version_added ||
          (typeof tcd?.version_added === "string" &&
            override.version_added === true)
        )
      ) {
        if (!modifiedEntry) {
          modifiedEntry = {};
        }
        modifiedEntry[k] = overrideEntry[k];
        tcdEntry[k] = { support: { thunderbird: override } };
      }
    } else if (tcdEntry[k]) {
      const childMod = overrideBrowserCompatData(
        overrideEntry[k],
        tcdEntry[k],
        `${parent}.${k}`
      );
      if (childMod) {
        if (!modifiedEntry) {
          modifiedEntry = {};
        }
        modifiedEntry[k] = childMod;
      }
    } else {
      tcdEntry[k] = overrideEntry[k];
      if (!modifiedEntry) {
        modifiedEntry = {};
      }
      modifiedEntry[k] = overrideEntry[k];
    }
  });

  return modifiedEntry;
}

// Remove properties, if all properties have the same version_added data as the
// parent. Do not remove entries with additional __compat data.
function reduceBrowserCompatData(tcdEntry, parentKey, path = "") {
  /*
  TODO:
"details": {
                        "__compat": {
                            "support": {
                                "thunderbird": {
                                    "version_added": true
                                }
                            }
                        }
                    },
                    "details_tabId_parameter": {
                        "__compat": {
                            "support": {
                                "thunderbird": {
                                    "version_added": true
                                }
                            }
                        }
                    },  
  */

  if (typeof tcdEntry !== "object" || !tcdEntry) {
    console.error(
      `Error: Should not find an non-object entry in BCD data: ${tcdEntry}`
    );
    return undefined;
  }
  if (Array.isArray(tcdEntry)) {
    console.error(
      `Error: Should not find an array entry in BCD data: ${tcdEntry}`
    );
    return undefined;
  }

  const parentCompatStrings = new Set();
  const parentCompatEntries = sortKeys(tcdEntry?.__compat?.support);
  let parentCompatVendors = [];
  let parentCompatString = "";
  if (parentCompatEntries) {
    parentCompatVendors = Object.keys(parentCompatEntries);
    parentCompatString = JSON.stringify(parentCompatEntries);
    parentCompatStrings.add(parentCompatString);
  }

  // Check all children and remove children which have the same version_added
  // entries as the parent. Make sure to only remove thunderbird entries and only
  // if no other vendors are listed.
  Object.keys(tcdEntry).forEach(k => {
    if (k != "__compat") {
      const childCompatStrings = [
        ...reduceBrowserCompatData(tcdEntry[k], k, `${path}.${k}`),
      ];
      // Add the childs compat data to the global parent compat data.
      childCompatStrings.forEach(e => parentCompatStrings.add(e));
      // Compare this child with parent directly.
      if (
        path.split(".").length > 3 &&
        parentCompatVendors.length == 1 &&
        parentCompatVendors[0] == "thunderbird" &&
        childCompatStrings.length == 1 &&
        childCompatStrings[0] == parentCompatString
      ) {
        delete tcdEntry[k];
      }
    }
  });

  return parentCompatStrings;
}

function checkForMissingThunderbirdEntries(tcdEntry, path = "") {
  if (typeof tcdEntry !== "object" || !tcdEntry) {
    console.error(
      `Error: Should not find an non-object entry in BCD data: ${tcdEntry}`
    );
    return;
  }
  if (Array.isArray(tcdEntry)) {
    console.error(
      `Error: Should not find an array entry in BCD data: ${tcdEntry}`
    );
    return;
  }

  // If this entity is unsupported, do not dive into its properties.
  const isSupported = tcdEntry?.__compat?.support?.thunderbird?.version_added;
  if (isSupported === false) {
    return;
  }

  Object.keys(tcdEntry).forEach(k => {
    if (k == "__compat") {
      const support = tcdEntry[k]?.support;
      if (support) {
        const vendors = Object.keys(support);
        if (!vendors.includes("thunderbird")) {
          console.error(
            `Error: Missing thunderbird entry in: ${path} (${vendors})`
          );
        }
      }
    } else {
      checkForMissingThunderbirdEntries(tcdEntry[k], `${path}.${k}`);
    }
  });
}
// -----------------------------------------------------------------------------

function processImports(namespaces) {
  for (let i = 0; i < namespaces.length; i++) {
    const namespaceObj = namespaces[i];
    namespaces[i] = _processImports(namespaceObj, namespaces);
  }
  if (VERBOSITY & 1) {
    console.log("");
    console.log("Found namespace definitions after $import");
    console.log("=========================================");
    for (const namespaceObj of namespaces) {
      console.log(JSON.stringify(namespaceObj, null, 2));
    }
  }
}

/**
 * Helper function to find an element or namespace in the provided schema obj.
 *
 * @param {any} value - The value to process. Usually the global schema data, but
 *   the function recursively calls itself on nested elements.
 * @param {string} searchString - The id or namespace name to look for.
 *
 * @returns {any} The processed value.
 */
function getNestedIdOrNamespace(value, searchString) {
  if (typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      const rv = getNestedIdOrNamespace(element, searchString);
      if (rv !== undefined) {
        return rv;
      }
    }
    return undefined;
  }

  // An object.
  if (value.namespace == searchString) {
    return value;
  }
  if (value.id == searchString) {
    return value;
  }
  for (const element of Object.values(value)) {
    const rv = getNestedIdOrNamespace(element, searchString);
    if (rv !== undefined) {
      return rv;
    }
  }
  return undefined;
}

function collectNamespaceEntriesAndResolveRefs(
  value,
  entries,
  all_namespaces,
  parentKey,
  handledRefs = [],
  fullPath = ""
) {
  if (typeof value !== "object") {
    if (parentKey == "enum") {
      entries.set(`${fullPath}.${value}`, value);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach(e => {
      collectNamespaceEntriesAndResolveRefs(
        e,
        entries,
        all_namespaces,
        parentKey,
        [...handledRefs],
        fullPath
      );
    });
    return;
  }

  // Looks like value is an object. Find out where we are and build the path.
  if (value.namespace) {
    // Reset.
    fullPath = value.namespace;
  }
  if (value.name && typeof value.name !== "object") {
    fullPath = `${fullPath}.${value.name}`;
  } else if (value.id && typeof value.id !== "object") {
    fullPath = `${fullPath}.${value.id}`;
  }

  if (fullPath) {
    entries.set(fullPath, value);
    if (VERBOSITY & 2) {
      console.log(fullPath);
    }
  }

  const handleRef = value => {
    const refId = value.$ref;
    const parts = refId.split(".");
    const id = parts.pop();
    const requested_namespace = parts[0];
    const current_namespace = fullPath.split(".")[0];

    // Search the specified namespace, the local namespace, the manifest namespace
    // and then all other namespaces.
    const searchNamespaces = [
      requested_namespace,
      current_namespace,
      "manifest",
      ...all_namespaces.map(n => n.namespace),
    ];
    for (const searchNamespace of searchNamespaces) {
      const searchSchemas = all_namespaces.filter(
        n => n.namespace == searchNamespace
      );
      for (const searchSchema of searchSchemas) {
        const ref = getNestedIdOrNamespace(searchSchema, id);
        if (ref) {
          // Deep-clone the found ref to prevent circular dependencies.
          return JSON.parse(JSON.stringify(ref));
        }
      }
    }
    console.log(`Warning: Missing requested $ref: ${id} (${refId})`);
    return null;
  };

  // Replace $refs, but ignore recursive usages.
  if (value.$ref && !handledRefs.includes(value.$ref)) {
    const ref = handleRef(value);
    if (ref) {
      handledRefs.push(value.$ref);
      Object.assign(value, ref);
      delete value.$ref;
      delete value.id;
    }
  }

  Object.keys(value).forEach(key => {
    switch (key) {
      case "choices":
        collectNamespaceEntriesAndResolveRefs(
          value[key],
          entries,
          all_namespaces,
          key,
          [...handledRefs],
          fullPath
        );
        break;
      default:
        collectNamespaceEntriesAndResolveRefs(
          value[key],
          entries,
          all_namespaces,
          key,
          [...handledRefs],
          `${fullPath}.${key}`
        );
    }
  });
}

/**
 * Replace $import statements by the actual referenced element/namespace.
 *
 * @param {any} obj - The value to process. Usually a schema JSON, but the
 *   function recursively calls itself on nested elements.
 *
 * @returns {any} The processed value.
 */
function _processImports(obj, all_namespaces) {
  if (typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(v => _processImports(v, all_namespaces));
  }

  if (obj.hasOwnProperty("$import")) {
    // Assume imports are unique, ignore prepended namespace.
    const id = obj.$import;

    // TODO: We skip ManifestBase for now.
    if (id == "manifest.ManifestBase") {
      return obj;
    }

    for (const searchSchema of all_namespaces) {
      let imported = getNestedIdOrNamespace(searchSchema, id);
      if (imported) {
        // Do not import top level manifest limits.
        imported = JSON.parse(JSON.stringify(imported));
        delete imported.min_manifest_version;
        delete imported.max_manifest_version;
        // Do not import namespace name and id.
        delete imported.namespace;
        delete imported.id;
        delete obj.$import;
        return mergeObjects(obj, imported);
      }
    }
    console.error(`Warning: Missing requested $import: ${id}`);
  }

  // Default.
  return Object.keys(obj).reduce((o, key) => {
    o[key] = _processImports(obj[key], all_namespaces);
    return o;
  }, {});
}

// -----------------------------------------------------------------------------

function updateCompatData(
  tcd,
  namespace_entry,
  compatEntry,
  logEntries,
  skipFlatPropsCheck = false
) {
  const expected = compatEntry.version_added;
  const parts = namespace_entry.split(".");
  const [namespace, entryType, entryName] = parts;
  const curr_namespace_parts = [];
  if (VERBOSITY & 4) {
    console.log(`Processing ${namespace_entry} : ${expected}`);
  }

  const newEntry = () => {
    return {
      __compat: {
        support: {
          thunderbird: compatEntry,
        },
      },
    };
  };

  const detectNotation = (
    entry,
    itemName,
    parent,
    parentItemName,
    curr_namespace_entry
  ) => {
    // The notation used in BCD is very very inconsistent. They even use different
    // notations within the same parameter. See action.setIcon
    // https://github.com/mdn/browser-compat-data/blob/7afd5da3bfe0e0f4434585ee75f277d784662caf/webextensions/api/action.json#L605

    // We therefore first check if the _parameter or _value notation is used, and
    // then check on the specific element and issue a warning if mixed data has
    // been found.
    let rv;

    if (parent) {
      // Detect <paramName>_<propertyName>_parameter notation used in this parameter.
      const dashedParameterNotation = Object.keys(parent).filter(
        e => e.startsWith(`${parentItemName}_`) && e.endsWith(`_parameter`)
      );
      if (dashedParameterNotation.length) {
        if (VERBOSITY & 4) {
          console.log(`Notation (_parameter): ${dashedParameterNotation}`);
        }
        rv = {
          notation: "_parameter",
          processEntry: parent,
          processKey: `${parentItemName}_${itemName}_parameter`,
        };
      }

      // Detect <propertyName>_value notation used in this parameter.
      const dashedValueNotation = Object.keys(parent).filter(e =>
        e.endsWith(`_value`)
      );
      if (dashedValueNotation.length) {
        if (VERBOSITY & 4) {
          console.log(`Notation (_value): ${dashedValueNotation}`);
        }
        if (rv) {
          logEntries.add(
            `Warning: Found MIXED notations for ${curr_namespace_entry}`
          );
        }
        rv = {
          notation: "_value",
          processEntry: parent,
          processKey: `${itemName}_value`,
        };
      }

      // Detect flat notation for the specified element.
      if (
        CONFIRMED_FLAT_PROPS.some(
          e =>
            curr_namespace_entry.split(".").length == e.split(".").length &&
            curr_namespace_entry.startsWith(e)
        )
      ) {
        logEntries.add(
          `Info: Accepted confirmed flat notation usage: ${curr_namespace_entry}`
        );
        rv = {
          notation: "flat",
          processEntry: parent,
          processKey: itemName,
        };
      } else if (!skipFlatPropsCheck) {
        const flatNotation = Object.keys(parent).filter(e => e == itemName);
        if (flatNotation.length) {
          if (VERBOSITY & 4) {
            console.log(`Notation (flat): ${flatNotation}`);
          }
          if (rv) {
            logEntries.add(
              `Warning: Found MIXED notations: ${curr_namespace_entry}`
            );
          }
          if (
            !KNOWN_FALSE_POSITIVE_FLAT_PROPS.some(e =>
              curr_namespace_entry.startsWith(e)
            )
          ) {
            logEntries.add(
              `Info: Ignored unconfirmed but potential flat notation usage: ${curr_namespace_entry}`
            );
          }
        }
      }
    }

    return (
      rv || {
        notation: "nested",
        processEntry: entry,
        processKey: itemName,
      }
    );
  };

  const handleEntry = (entry, itemName) => {
    const curr_namespace_entry = curr_namespace_parts.join(".");
    if (VERBOSITY & 4) {
      console.log(`  handling: ${curr_namespace_entry} / ${namespace_entry}`);
    }

    if (!expected) {
      if (curr_namespace_entry == namespace_entry) {
        // If expected to be unsupported, replace the entire entity with a single
        // compat value.
        if (VERBOSITY & 4) {
          console.log(`  replacing: ${namespace_entry}`);
        }
        entry[itemName] = newEntry();
        return false;
      }
      if (entry[itemName]) {
        // The current level element exists, but we have not reached the final
        // depth. Do not touch it and process the next level.
        return true;
      }
      // The current level element does exists, create it and process the next
      // level! The final cleanup will reduce such hierarchies to a minimum.
      if (VERBOSITY & 4) {
        console.log(`  adding intermediate: ${namespace_entry}`);
      }
      entry[itemName] = newEntry();
      return true;
    }

    // Add the current level entry, if missing.
    if (!entry[itemName]) {
      if (VERBOSITY & 4) {
        console.log(`  adding: ${expected} : ${curr_namespace_entry}`);
      }
      entry[itemName] = newEntry();
    }

    // Add or update __compat of current level.
    if (!entry[itemName].__compat?.support?.thunderbird?.version_added) {
      if (VERBOSITY & 4) {
        console.log(`  setting as true: ${expected} : ${curr_namespace_entry}`);
      }
      entry[itemName].__compat = newEntry().__compat;
    } else if (
      entry[itemName].__compat.support.thunderbird.version_added === false
    ) {
      if (VERBOSITY & 4) {
        console.log(`  forcing to true: ${expected} : ${curr_namespace_entry}`);
      }
      entry[itemName].__compat.support.thunderbird.version_added = expected;
    }

    if (curr_namespace_entry == namespace_entry) {
      if (VERBOSITY & 4) {
        console.log(`  finished: ${namespace_entry}`);
      }
      return false;
    }

    return true;
  };

  if (namespace) {
    curr_namespace_parts.push(namespace);
    if (VERBOSITY & 4) {
      console.log(`  next ${curr_namespace_parts.join(" ")}`);
    }

    if (namespace == "manifest") {
      // TODO: Handle manifest entries.
      return;
    }
    if (!handleEntry(tcd.webextensions.api, namespace)) {
      return;
    }
  }

  if (
    namespace &&
    entryType &&
    entryName &&
    ["functions", "events", "properties", "types"].includes(entryType)
  ) {
    curr_namespace_parts.push(entryType);
    curr_namespace_parts.push(entryName);
    if (VERBOSITY & 4) {
      console.log(`  next ${curr_namespace_parts.join(" ")}`);
    }

    if (!handleEntry(tcd.webextensions.api[namespace], entryName)) {
      return;
    }
    if (`${namespace}.${entryType}.${entryName}` == namespace_entry) {
      // No further processing, if the entire schema entry has been processed.
      return;
    }
  } else if (VERBOSITY & 4) {
    console.log(`  skipped ${namespace} ${entryType} ${entryName}`);
  }

  if (
    namespace &&
    entryType &&
    entryName &&
    ["functions", "events", "types"].includes(entryType) &&
    parts.length > 3
  ) {
    let parentEntryName = namespace;
    let parent = tcd.webextensions.api[parentEntryName];
    let entry = parent[entryName];
    for (let i = 3; i < parts.length; i += 2) {
      // Process a sub-entry of the current entry.
      const subEntryType = parts[i];
      const subEntryName = parts[i + 1];
      curr_namespace_parts.push(subEntryType);
      curr_namespace_parts.push(subEntryName);
      if (VERBOSITY & 4) {
        console.log(`  next ${curr_namespace_parts.join(" ")}`);
      }

      if (!subEntryType || !subEntryName || subEntryName == "callback") {
        // No further processing.
        if (VERBOSITY & 4) {
          console.log(`  finished (not enough data or callback)`);
        }
        return;
      }
      if (!["properties", "parameters", "enum"].includes(subEntryType)) {
        // No further processing, but break to reach the final log statement.
        if (VERBOSITY & 4) {
          console.log(`  finished (ignore group: ${subEntryType})`);
        }
        break;
      }

      const { processEntry, processKey } = detectNotation(
        entry,
        subEntryName,
        parent,
        parentEntryName,
        curr_namespace_parts.join(".")
      );

      if (!handleEntry(processEntry, processKey)) {
        return;
      }

      parentEntryName = processKey;
      parent = processEntry;
      entry = parent[processKey];
    }
  }

  // Suppress logging for top level entries, for which entries are expected to
  // not be generated.
  if (parts.length > 2) {
    if (VERBOSITY & 4) {
      console.log(`IGNORED for expected ${expected} : ${namespace_entry}`);
    }
  }
}
