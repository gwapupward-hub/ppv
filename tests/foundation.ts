import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const PROOF_SEED = new TextEncoder().encode("proof");
const AGREEMENT_SEED = new TextEncoder().encode("agreement");
const MAX_AGREEMENT_TTL_SECS = 365 * 24 * 60 * 60;
const ZERO_HASH = Array<number>(32).fill(0);

function id16(): number[] {
  return [...randomBytes(16)];
}

function hash32(marker: number): number[] {
  return Array<number>(32).fill(marker);
}

function proofAddress(
  programId: PublicKey,
  authority: PublicKey,
  proofId: number[],
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PROOF_SEED, authority.toBytes(), Uint8Array.from(proofId)],
    programId,
  )[0];
}

function agreementAddress(
  programId: PublicKey,
  partyA: PublicKey,
  agreementId: number[],
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [AGREEMENT_SEED, partyA.toBytes(), Uint8Array.from(agreementId)],
    programId,
  )[0];
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof anchor.AnchorError) {
    return error.error.errorCode.code;
  }
  return undefined;
}

async function expectAnchorError(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
    assert.fail(`expected Anchor error ${expectedCode}`);
  } catch (error) {
    const actualCode = errorCode(error);
    if (actualCode !== undefined) {
      assert.equal(actualCode, expectedCode);
      return;
    }
    assert.match(String(error), new RegExp(expectedCode, "i"));
  }
}

async function chainTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  assert.notEqual(blockTime, null, "local validator did not return block time");
  return blockTime as number;
}

async function waitForChainTime(
  connection: Connection,
  targetUnixSeconds: number,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await chainTime(connection)) >= targetUnixSeconds) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`validator clock did not reach ${targetUnixSeconds}`);
}

async function fundAuthority(
  connection: Connection,
  authority: PublicKey,
): Promise<void> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const signature = await connection.requestAirdrop(authority, LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

describe("PPV Foundation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Generated IDL types are created by `anchor build`; `any` keeps this source
  // type-checkable before build while runtime calls still use the generated IDL.
  const core = anchor.workspace.PpvCore as any;
  const commerce = anchor.workspace.PpvCommerce as any;

  describe("ppv_core", () => {
    it("creates wallet-namespaced evidence and enforces terminal revocation", async () => {
      const authority = provider.wallet.publicKey;
      const secondAuthority = Keypair.generate();
      const outsider = Keypair.generate();
      const proofId = id16();
      const contentHash = hash32(11);
      const contextHash = hash32(12);
      const proof = proofAddress(core.programId, authority, proofId);
      const secondProof = proofAddress(
        core.programId,
        secondAuthority.publicKey,
        proofId,
      );

      assert.notEqual(proof.toBase58(), secondProof.toBase58());

      await core.methods
        .createProof(proofId, contentHash, contextHash, { document: {} })
        .accounts({
          authority,
          proof,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const created = await core.account.proofRecord.fetch(proof);
      assert.equal(created.authority.toBase58(), authority.toBase58());
      assert.deepEqual([...created.contentHash], contentHash);
      assert.ok("active" in created.status);
      assert.equal(created.revokedAt.toNumber(), 0);

      await expectAnchorError(
        core.methods
          .revokeProof()
          .accounts({ authority: outsider.publicKey, proof })
          .signers([outsider])
          .rpc(),
        "Unauthorized",
      );

      await assert.rejects(
        core.methods
          .createProof(proofId, contentHash, contextHash, { document: {} })
          .accounts({
            authority,
            proof,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      );

      await fundAuthority(provider.connection, secondAuthority.publicKey);
      await core.methods
        .createProof(proofId, contentHash, contextHash, { document: {} })
        .accounts({
          authority: secondAuthority.publicKey,
          proof: secondProof,
          systemProgram: SystemProgram.programId,
        })
        .signers([secondAuthority])
        .rpc();
      const namespaced = await core.account.proofRecord.fetch(secondProof);
      assert.equal(
        namespaced.authority.toBase58(),
        secondAuthority.publicKey.toBase58(),
      );

      await core.methods
        .revokeProof()
        .accounts({ authority, proof })
        .rpc();

      const revoked = await core.account.proofRecord.fetch(proof);
      assert.ok("revoked" in revoked.status);
      assert.ok(revoked.revokedAt.toNumber() > 0);

      await expectAnchorError(
        core.methods
          .revokeProof()
          .accounts({ authority, proof })
          .rpc(),
        "AlreadyRevoked",
      );
    });

    it("rejects an empty content commitment without allocating evidence", async () => {
      const authority = provider.wallet.publicKey;
      const proofId = id16();
      const proof = proofAddress(core.programId, authority, proofId);

      await expectAnchorError(
        core.methods
          .createProof(proofId, ZERO_HASH, ZERO_HASH, { other: {} })
          .accounts({
            authority,
            proof,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "InvalidContentHash",
      );
      assert.equal(await provider.connection.getAccountInfo(proof), null);
    });
  });

  describe("ppv_commerce", () => {
    async function expectCreateError(
      partyB: PublicKey,
      contentHash: number[],
      termsHash: number[],
      expiresAt: number,
      expectedCode: string,
    ): Promise<void> {
      const partyA = provider.wallet.publicKey;
      const agreementId = id16();
      const agreement = agreementAddress(
        commerce.programId,
        partyA,
        agreementId,
      );

      await expectAnchorError(
        commerce.methods
          .createAgreement(
            agreementId,
            partyB,
            contentHash,
            termsHash,
            new BN(expiresAt),
          )
          .accounts({
            partyA,
            agreement,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        expectedCode,
      );
      assert.equal(await provider.connection.getAccountInfo(agreement), null);
    }

    it("binds signatures to one exact version and both hashes", async () => {
      const partyA = provider.wallet.publicKey;
      const partyB = Keypair.generate();
      const outsider = Keypair.generate();
      const agreementId = id16();
      const contentV1 = hash32(21);
      const termsV1 = hash32(22);
      const contentV2 = hash32(23);
      const termsV2 = hash32(24);
      const agreement = agreementAddress(
        commerce.programId,
        partyA,
        agreementId,
      );
      const expiresAt = new BN((await chainTime(provider.connection)) + 600);

      await commerce.methods
        .createAgreement(
          agreementId,
          partyB.publicKey,
          contentV1,
          termsV1,
          expiresAt,
        )
        .accounts({
          partyA,
          agreement,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await expectAnchorError(
        commerce.methods
          .signAgreement(1, contentV1, termsV1)
          .accounts({ signer: outsider.publicKey, agreement })
          .signers([outsider])
          .rpc(),
        "NotAParty",
      );
      await expectAnchorError(
        commerce.methods
          .proposeRevision(1, contentV2, termsV2)
          .accounts({ signer: outsider.publicKey, agreement })
          .signers([outsider])
          .rpc(),
        "NotAParty",
      );
      await expectAnchorError(
        commerce.methods
          .cancelAgreement()
          .accounts({ signer: outsider.publicKey, agreement })
          .signers([outsider])
          .rpc(),
        "NotAParty",
      );

      await commerce.methods
        .signAgreement(1, contentV1, termsV1)
        .accounts({ signer: partyA, agreement })
        .rpc();
      await expectAnchorError(
        commerce.methods
          .signAgreement(1, contentV1, termsV1)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "AlreadySigned",
      );

      await commerce.methods
        .proposeRevision(1, contentV2, termsV2)
        .accounts({ signer: partyB.publicKey, agreement })
        .signers([partyB])
        .rpc();

      const revised = await commerce.account.agreement.fetch(agreement);
      assert.equal(revised.version, 2);
      assert.equal(revised.sigA, null);
      assert.equal(revised.sigB, null);

      await expectAnchorError(
        commerce.methods
          .proposeRevision(1, hash32(25), hash32(26))
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "StaleVersion",
      );
      await expectAnchorError(
        commerce.methods
          .proposeRevision(2, contentV2, termsV2)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "NoChanges",
      );
      await expectAnchorError(
        commerce.methods
          .proposeRevision(2, ZERO_HASH, termsV2)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "InvalidContentHash",
      );
      await expectAnchorError(
        commerce.methods
          .proposeRevision(2, contentV2, ZERO_HASH)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "InvalidTermsHash",
      );
      await expectAnchorError(
        commerce.methods
          .signAgreement(1, contentV1, termsV1)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "StaleVersion",
      );
      await expectAnchorError(
        commerce.methods
          .signAgreement(2, contentV1, termsV2)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "ContentHashMismatch",
      );
      await expectAnchorError(
        commerce.methods
          .signAgreement(2, contentV2, termsV1)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "TermsHashMismatch",
      );

      await commerce.methods
        .signAgreement(2, contentV2, termsV2)
        .accounts({ signer: partyA, agreement })
        .rpc();
      await commerce.methods
        .signAgreement(2, contentV2, termsV2)
        .accounts({ signer: partyB.publicKey, agreement })
        .signers([partyB])
        .rpc();

      const executed = await commerce.account.agreement.fetch(agreement);
      assert.ok("executed" in executed.state);
      assert.equal(executed.version, 2);
      assert.equal(executed.sigA.versionSigned, 2);
      assert.equal(executed.sigB.versionSigned, 2);
      assert.deepEqual([...executed.sigA.contentHashSigned], contentV2);
      assert.deepEqual([...executed.sigA.termsHashSigned], termsV2);
      assert.deepEqual([...executed.sigB.contentHashSigned], contentV2);
      assert.deepEqual([...executed.sigB.termsHashSigned], termsV2);

      await expectAnchorError(
        commerce.methods
          .signAgreement(2, contentV2, termsV2)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "BadState",
      );
      await expectAnchorError(
        commerce.methods
          .proposeRevision(2, hash32(25), hash32(26))
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "BadState",
      );
      await expectAnchorError(
        commerce.methods
          .cancelAgreement()
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "BadState",
      );
    });

    it("rejects every invalid agreement creation boundary", async () => {
      const partyA = provider.wallet.publicKey;
      const partyB = Keypair.generate();
      const now = await chainTime(provider.connection);
      const contentHash = hash32(31);
      const termsHash = hash32(32);

      await expectCreateError(
        partyA,
        contentHash,
        termsHash,
        now + 600,
        "InvalidParty",
      );
      await expectCreateError(
        PublicKey.default,
        contentHash,
        termsHash,
        now + 600,
        "InvalidParty",
      );
      await expectCreateError(
        partyB.publicKey,
        ZERO_HASH,
        termsHash,
        now + 600,
        "InvalidContentHash",
      );
      await expectCreateError(
        partyB.publicKey,
        contentHash,
        ZERO_HASH,
        now + 600,
        "InvalidTermsHash",
      );
      await expectCreateError(
        partyB.publicKey,
        contentHash,
        termsHash,
        now - 1,
        "InvalidExpiry",
      );
      await expectCreateError(
        partyB.publicKey,
        contentHash,
        termsHash,
        now + MAX_AGREEMENT_TTL_SECS + 60,
        "InvalidExpiry",
      );
    });

    it("keeps cancellation terminal", async () => {
      const partyA = provider.wallet.publicKey;
      const partyB = Keypair.generate();
      const outsider = Keypair.generate();
      const agreementId = id16();
      const agreement = agreementAddress(
        commerce.programId,
        partyA,
        agreementId,
      );
      const contentHash = hash32(41);
      const termsHash = hash32(42);

      await commerce.methods
        .createAgreement(
          agreementId,
          partyB.publicKey,
          contentHash,
          termsHash,
          new BN((await chainTime(provider.connection)) + 600),
        )
        .accounts({
          partyA,
          agreement,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await expectAnchorError(
        commerce.methods
          .cancelAgreement()
          .accounts({ signer: outsider.publicKey, agreement })
          .signers([outsider])
          .rpc(),
        "NotAParty",
      );
      await commerce.methods
        .cancelAgreement()
        .accounts({ signer: partyB.publicKey, agreement })
        .signers([partyB])
        .rpc();

      const cancelled = await commerce.account.agreement.fetch(agreement);
      assert.ok("cancelled" in cancelled.state);
      assert.ok(cancelled.cancelledAt.toNumber() > 0);

      await expectAnchorError(
        commerce.methods
          .signAgreement(1, contentHash, termsHash)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "BadState",
      );
      await expectAnchorError(
        commerce.methods
          .proposeRevision(1, hash32(43), hash32(44))
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "BadState",
      );
      await expectAnchorError(
        commerce.methods
          .cancelAgreement()
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "BadState",
      );
    });

    it("blocks signatures and revisions at the expiry boundary", async () => {
      const partyA = provider.wallet.publicKey;
      const partyB = Keypair.generate();
      const agreementId = id16();
      const agreement = agreementAddress(
        commerce.programId,
        partyA,
        agreementId,
      );
      const contentHash = hash32(51);
      const termsHash = hash32(52);
      const expiresAt = (await chainTime(provider.connection)) + 4;

      await commerce.methods
        .createAgreement(
          agreementId,
          partyB.publicKey,
          contentHash,
          termsHash,
          new BN(expiresAt),
        )
        .accounts({
          partyA,
          agreement,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await waitForChainTime(provider.connection, expiresAt);

      await expectAnchorError(
        commerce.methods
          .signAgreement(1, contentHash, termsHash)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "Expired",
      );
      await expectAnchorError(
        commerce.methods
          .proposeRevision(1, hash32(53), hash32(54))
          .accounts({ signer: partyB.publicKey, agreement })
          .signers([partyB])
          .rpc(),
        "Expired",
      );

      const expired = await commerce.account.agreement.fetch(agreement);
      assert.ok("pending" in expired.state);
      assert.equal(expired.sigA, null);
      assert.equal(expired.sigB, null);
    });
  });
});
