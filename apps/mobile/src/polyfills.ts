import { getRandomValues } from 'expo-crypto';
import nacl from 'tweetnacl';

// Hermes has no WebCrypto; tweetnacl needs a CSPRNG for secretbox nonces.
nacl.setPRNG((x, n) => x.set(getRandomValues(new Uint8Array(n))));
