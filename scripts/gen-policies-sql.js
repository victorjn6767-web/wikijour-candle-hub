'use strict';
// Writes sql/hub-policies.sql from src/hub/policies.js (a test checks the committed file is current).
require('fs').writeFileSync(require('path').join(__dirname, '..', 'sql', 'hub-policies.sql'), require('../src/hub/policies').generateSql());
