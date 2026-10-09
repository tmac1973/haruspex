const { average } = require('./stats');

const result = average([2, 4, 6]);
console.log(`average([2, 4, 6]) = ${result}`);
if (result !== 4) {
	console.error('FAIL: expected 4');
	process.exit(1);
}
console.log('OK');
