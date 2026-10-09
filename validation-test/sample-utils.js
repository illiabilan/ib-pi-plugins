// Sample utility functions to establish patterns

function formatMessage(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Text must be a string');
  }
  return `Message: ${text}`;
}

function calculateSum(numbers) {
  if (!Array.isArray(numbers)) {
    throw new TypeError('Numbers must be an array');
  }
  return numbers.reduce((sum, n) => sum + n, 0);
}

module.exports = {
  formatMessage,
  calculateSum
};
