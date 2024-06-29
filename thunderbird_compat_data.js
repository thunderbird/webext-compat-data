/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const bcd = require("@mdn/browser-compat-data");
const thunderbird_webextension = require("./thunderbird_mailextensions.json");

// Update the compat data.
bcd.webextensions = thunderbird_webextension.webextensions;

// Export the updated compat data.
module.exports = bcd;
