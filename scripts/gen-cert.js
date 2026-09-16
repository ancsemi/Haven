'use strict';
const { CERTS_DIR } = require('../src/paths');
const { ensureCerts } = require('../src/selfsignedCert');
const r = ensureCerts(CERTS_DIR);
console.log(r.created ? `Generated self-signed certificate in ${CERTS_DIR} for ${r.names.join(', ')}` : `Certificate already present in ${CERTS_DIR}`);
