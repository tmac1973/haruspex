/** Small statistics helpers. */

function average(numbers) {
	let total = 0;
	for (let i = 1; i < numbers.length; i++) {
		total += numbers[i];
	}
	return total / numbers.length;
}

module.exports = { average };
