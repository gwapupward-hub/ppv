import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const PROOF_SEED = new TextEncoder().encode("proof");
const AGREEMENT_SEED = new TextEncoder().encode("agreement");

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

describe("PPV Foundation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Generated IDL types are created by `anchor build`; `any` keeps this source
  // type-checkable before build while all runtime calls still use the IDL.
  const core = anchor.workspace.PpvCore as any;
  const commerce = anchor.workspace.PpvCommerce as any;

  describe("ppv_core", () => {
    it("creates immutable evidence and permits only terminal authority revocation", async () => {
      const authority = provider.wallet.publicKey;
      const outsider = Keypair.generate();
      const proofId = id16();
      const contentHash = hash32(11);
      const contextHash = hash32(12);
      const proof = proofAddress(core.programId, authority, proofId);

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
  });

  describe("ppv_commerce", () => {
    it("binds signatures to the exact version and both hashes", async () => {
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
      const expiresAt = new BN(Math.floor(Date.now() / 1_000) + 600);

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

      await commerce.methods
        .signAgreement(1, contentV1, termsV1)
        .accounts({ signer: partyA, agreement })
        .rpc();

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
          .signAgreement(1, contentV1, termsV1)
          .accounts({ signer: partyA, agreement })
          .rpc(),
        "StaleVersion",
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
      assert.deepEqual([...executed.sigA.contentHashSigned], contentV2);
      assert.deepEqual([...executed.sigA.termsHashSigned], termsV2);
      assert.deepEqual([...executed.sigB.contentHashSigned], contentV2);
      assert.deepEqual([...executed.sigB.termsHashSigned], termsV2);

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

    it("keeps cancellation terminal and rejects invalid creation inputs", async () => {
      const partyA = provider.wallet.publicKey;
      const partyB = Keypair.generate();
      const agreementId = id16();
      const agreement = agreementAddress(
        commerce.programId,
        partyA,
        agreementId,
      );
      const contentHash = hash32(31);
      const termsHash = hash32(32);

      await expectAnchorError(
        commerce.methods
          .createAgreement(
            agreementId,
            partyA,
            contentHash,
            termsHash,
            new BN(Math.floor(Date.now() / 1_000) + 600),
          )
          .accounts({
            partyA,
            agreement,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "InvalidParty",
      );

      await commerce.methods
        .createAgreement(
          agreementId,
          partyB.publicKey,
          contentHash,
          termsHash,
          new BN(Math.floor(Date.now() / 1_000) + 600),
        )
        .accounts({
          partyA,
          agreement,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

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
    });
  });
});
