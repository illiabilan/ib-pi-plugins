// Greeting utility functions

function greet(name) {
  if (name === undefined || name === null || name === '') {
    return 'Hello, stranger!';
  }
  if (typeof name !== 'string') {
    throw new TypeError('Name must be a string');
  }
  return `Hello, ${name}!`;
}

module.exports = {
  greet
};
