// Module worker that runs the built-in engine off the main thread.
import { Chess } from '../../vendor/chess.js/chess.js';
import { searchBest } from './basic-search.js';

self.onmessage = (e) => {
  const { id, fen, opts } = e.data;
  try {
    postMessage({ id, result: searchBest(Chess, fen, opts) });
  } catch (err) {
    postMessage({ id, error: String((err && err.message) || err) });
  }
};
