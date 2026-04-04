function sanitizePrintableText(texto) {
  const input = String(texto || '');
  return input
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\r\n/g, '\n');
}

function stripResidualTags(line) {
  return String(line || '').replace(/\[\/?[A-Z0-9]+\]/g, '').trimRight();
}

module.exports = {
  sanitizePrintableText,
  stripResidualTags
};
