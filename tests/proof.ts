import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { randomBytes, createHash } from "node:crypto";

const sha = (value: string) => [...createHash("sha256").update(value).digest()];
const randomId = () => [...randomBytes(16)];

describe("ppv_core proof registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PpvCore as Program<any>;
  const admin = provider.wallet;
  const [config] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  before(async () => {
    if (!(await provider.connection.getAccountInfo(config))) {
      await program.methods.initializeCore().accounts({ admin: admin.publicKey }).rpc();
    }
  });

  it("creates proof owned by signer", async () => {
    const proofId = randomId();
    const [proof] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("proof"), Buffer.from(proofId)], program.programId);
    const contentHash = sha("founding-proof-1");
    await program.methods.createProof(proofId, contentHash, sha("metadata-v1"), anchor.web3.PublicKey.default, 1).accounts({ owner: admin.publicKey, config, proof }).rpc();
    const record = await program.account.proofRecord.fetch(proof);
    assert.equal(record.owner.toBase58(), admin.publicKey.toBase58());
    assert.deepEqual([...record.contentHash], contentHash);
    assert.equal(record.revoked, false);
  });

  it("rejects replay of same proof id", async () => {
    const proofId = randomId();
    const [proof] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("proof"), Buffer.from(proofId)], program.programId);
    const args = [proofId, sha("replay"), sha("meta"), anchor.web3.PublicKey.default, 1] as const;
    await program.methods.createProof(...args).accounts({ owner: admin.publicKey, config, proof }).rpc();
    let failed = false;
    try { await program.methods.createProof(...args).accounts({ owner: admin.publicKey, config, proof }).rpc(); } catch { failed = true; }
    assert.equal(failed, true);
  });

  it("pause blocks create but not owner revocation", async () => {
    const proofId = randomId();
    const [proof] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("proof"), Buffer.from(proofId)], program.programId);
    await program.methods.createProof(proofId, sha("revocable"), sha("meta"), anchor.web3.PublicKey.default, 1).accounts({ owner: admin.publicKey, config, proof }).rpc();
    await program.methods.setPaused(true).accounts({ admin: admin.publicKey, config }).rpc();
    const blockedId = randomId();
    const [blockedProof] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("proof"), Buffer.from(blockedId)], program.programId);
    let blocked = false;
    try { await program.methods.createProof(blockedId, sha("blocked"), sha("meta"), anchor.web3.PublicKey.default, 1).accounts({ owner: admin.publicKey, config, proof: blockedProof }).rpc(); } catch { blocked = true; }
    assert.equal(blocked, true);
    await program.methods.revokeProof(sha("owner-request")).accounts({ owner: admin.publicKey, proof }).rpc();
    assert.equal((await program.account.proofRecord.fetch(proof)).revoked, true);
    await program.methods.setPaused(false).accounts({ admin: admin.publicKey, config }).rpc();
  });
});
