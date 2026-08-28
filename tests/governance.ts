import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import assert from "node:assert/strict";

const GOVERNANCE_SEED = Buffer.from("governance");
const VAULT_SEED = Buffer.from("vault");
const PROPOSAL_SEED = Buffer.from("proposal");
const UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

function u64(value: number): Buffer {
  return new BN(value).toArrayLike(Buffer, "le", 8);
}

function proposalAddress(
  programId: PublicKey,
  governance: PublicKey,
  proposalId: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PROPOSAL_SEED, governance.toBuffer(), u64(proposalId)],
    programId,
  )[0];
}

function anchorErrorCode(error: unknown): string | undefined {
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
    const code = anchorErrorCode(error);
    if (code !== undefined) {
      assert.equal(code, expectedCode);
      return;
    }
    assert.match(String(error), new RegExp(expectedCode, "i"));
  }
}

describe("PPV native governance", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const governanceProgram = anchor.workspace.PpvGovernance as any;

  const memberTwo = Keypair.generate();
  const memberThree = Keypair.generate();
  const [programData] = PublicKey.findProgramAddressSync(
    [governanceProgram.programId.toBuffer()],
    UPGRADEABLE_LOADER_ID,
  );
  const [governance] = PublicKey.findProgramAddressSync(
    [GOVERNANCE_SEED],
    governanceProgram.programId,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, governance.toBuffer()],
    governanceProgram.programId,
  );

  it("initializes a threshold-governed vault through the current loader authority", async () => {
    await governanceProgram.methods
      .initializeGovernance(
        [provider.wallet.publicKey, memberTwo.publicKey],
        2,
        new BN(0),
        new BN(1_000),
        provider.wallet.publicKey,
      )
      .accounts({
        payer: provider.wallet.publicKey,
        program: governanceProgram.programId,
        programData,
        governance,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await governanceProgram.account.governance.fetch(governance);
    const vaultState = await governanceProgram.account.governanceVault.fetch(vault);
    assert.equal(config.memberCount, 2);
    assert.equal(config.threshold, 2);
    assert.equal(config.epoch.toNumber(), 0);
    assert.equal(vaultState.governance.toBase58(), governance.toBase58());
  });

  it("requires threshold approvals and rejects duplicate votes", async () => {
    const proposalId = 0;
    const proposal = proposalAddress(
      governanceProgram.programId,
      governance,
      proposalId,
    );
    const targetProgram = Keypair.generate().publicKey;
    const buffer = Keypair.generate().publicKey;

    await governanceProgram.methods
      .createUpgradeProposal(new BN(proposalId), targetProgram, buffer)
      .accounts({
        proposer: provider.wallet.publicKey,
        governance,
        proposal,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await governanceProgram.methods
      .approveProposal()
      .accounts({
        member: provider.wallet.publicKey,
        governance,
        proposal,
      })
      .rpc();

    await expectAnchorError(
      governanceProgram.methods
        .approveProposal()
        .accounts({
          member: provider.wallet.publicKey,
          governance,
          proposal,
        })
        .rpc(),
      "AlreadyApproved",
    );

    await governanceProgram.methods
      .approveProposal()
      .accounts({
        member: memberTwo.publicKey,
        governance,
        proposal,
      })
      .signers([memberTwo])
      .rpc();

    const approved = await governanceProgram.account.proposal.fetch(proposal);
    assert.equal(approved.approvalCount, 2);
    assert.equal(approved.approvals, 3);
  });

  it("reconfigures through governance and invalidates proposals from the old epoch", async () => {
    const proposalId = 1;
    const proposal = proposalAddress(
      governanceProgram.programId,
      governance,
      proposalId,
    );

    await governanceProgram.methods
      .createReconfigurationProposal(
        new BN(proposalId),
        [provider.wallet.publicKey, memberTwo.publicKey, memberThree.publicKey],
        2,
        new BN(0),
        new BN(1_500),
        provider.wallet.publicKey,
      )
      .accounts({
        proposer: provider.wallet.publicKey,
        governance,
        proposal,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await governanceProgram.methods
      .approveProposal()
      .accounts({ member: provider.wallet.publicKey, governance, proposal })
      .rpc();
    await governanceProgram.methods
      .approveProposal()
      .accounts({ member: memberTwo.publicKey, governance, proposal })
      .signers([memberTwo])
      .rpc();

    await governanceProgram.methods
      .executeReconfiguration()
      .accounts({
        executor: provider.wallet.publicKey,
        governance,
        proposal,
      })
      .rpc();

    const config = await governanceProgram.account.governance.fetch(governance);
    assert.equal(config.memberCount, 3);
    assert.equal(config.threshold, 2);
    assert.equal(config.epoch.toNumber(), 1);

    const staleProposal = proposalAddress(
      governanceProgram.programId,
      governance,
      0,
    );
    await expectAnchorError(
      governanceProgram.methods
        .approveProposal()
        .accounts({
          member: memberThree.publicKey,
          governance,
          proposal: staleProposal,
        })
        .signers([memberThree])
        .rpc(),
      "StaleGovernanceEpoch",
    );
  });
});
