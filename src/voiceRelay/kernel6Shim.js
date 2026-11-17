'use strict';
/**
 * Loaded into the relay's install (addon.js) on its second try. mediasoup picks
 * its prebuilt program by the Linux kernel's major version, and its kernel 7
 * build needs newer system libraries than some systems have, Haven's own Docker
 * image included. The kernel 6 build runs on kernel 7 too, so ask for that one.
 */
const os = require('os');

os.release = () => '6.0.0';
require('module').syncBuiltinESMExports();
