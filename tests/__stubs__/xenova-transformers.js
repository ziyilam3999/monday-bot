const DIM = 384;

function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z]+/g) || []);
}

function hashToken(word) {
  let h = 0;
  for (let i = 0; i < word.length; i++) {
    h = (h * 31 + word.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

async function pipeline(_task, _modelId) {
  return async (text, _opts) => {
    const vec = new Array(DIM).fill(0);
    for (const word of tokenize(text)) {
      vec[hashToken(word) % DIM] += 1;
    }
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < DIM; i++) vec[i] /= norm;
    } else {
      vec[0] = 1;
    }
    return { data: vec };
  };
}

module.exports = { pipeline };
module.exports.pipeline = pipeline;
module.exports.default = { pipeline };
