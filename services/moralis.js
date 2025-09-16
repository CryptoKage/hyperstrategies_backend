// services/moralis.js
import Moralis from "moralis";

let started = false;
export async function ensureMoralis() {
  if (!started) {
    if (!process.env.MORALIS_API_KEY) {
      throw new Error("MORALIS_API_KEY missing");
    }
    await Moralis.start({ apiKey: process.env.MORALIS_API_KEY });
    started = true;
  }
  return Moralis;
}
