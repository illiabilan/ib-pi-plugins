// Farewell utility functions

function sayGoodbye(person) {
  if (person === undefined || person === null || person === '') {
    return 'Goodbye, friend!';
  }
  if (typeof person !== 'string') {
    throw new TypeError('Person must be a string');
  }
  return `Goodbye, ${person}!`;
}

module.exports = {
  sayGoodbye
};
