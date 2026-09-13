const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

export async function rpc(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export function encodeBase58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);

  let output = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    output = ALPHABET[remainder] + output;
  }
  return "1".repeat(zeros) + (output || (zeros ? "" : "1"));
}

export async function getGenesisHash(rpcUrl) {
  return rpc(rpcUrl, "getGenesisHash");
}

export async function getAccount(rpcUrl, address, commitment = "confirmed") {
  const result = await rpc(rpcUrl, "getAccountInfo", [
    address,
    { encoding: "base64", commitment },
  ]);
  if (!result?.value) return null;
  const [encoded] = result.value.data;
  return { ...result.value, bytes: Buffer.from(encoded, "base64") };
}

export async function programExists(rpcUrl, programId, commitment = "confirmed") {
  return (await getAccount(rpcUrl, programId, commitment)) !== null;
}

export async function getUpgradeableProgramState(rpcUrl, programId, commitment = "confirmed") {
  const program = await getAccount(rpcUrl, programId, commitment);
  if (!program) return { exists: false, programId };

  const result = {
    exists: true,
    programId,
    executable: Boolean(program.executable),
    owner: program.owner,
    programDataAddress: null,
    lastDeploySlot: null,
    authority: null,
  };

  if (program.owner !== UPGRADEABLE_LOADER || program.bytes.length < 36) return result;

  const programVariant = program.bytes.readUInt32LE(0);
  if (programVariant !== 2) return { ...result, programVariant };

  const programDataAddress = encodeBase58(program.bytes.subarray(4, 36));
  const programData = await getAccount(rpcUrl, programDataAddress, commitment);
  if (!programData) return { ...result, programVariant, programDataAddress };

  const programDataVariant = programData.bytes.length >= 4 ? programData.bytes.readUInt32LE(0) : null;
  let lastDeploySlot = null;
  let authority = null;
  if (programDataVariant === 3 && programData.bytes.length >= 13) {
    lastDeploySlot = Number(programData.bytes.readBigUInt64LE(4));
    const authorityTag = programData.bytes[12];
    if (authorityTag === 1 && programData.bytes.length >= 45) {
      authority = encodeBase58(programData.bytes.subarray(13, 45));
    }
  }

  return {
    ...result,
    programVariant,
    programDataAddress,
    programDataOwner: programData.owner,
    programDataVariant,
    lastDeploySlot,
    authority,
  };
}

export async function getSignatureStatus(rpcUrl, signature) {
  const result = await rpc(rpcUrl, "getSignatureStatuses", [
    [signature],
    { searchTransactionHistory: true },
  ]);
  return result?.value?.[0] ?? null;
}
