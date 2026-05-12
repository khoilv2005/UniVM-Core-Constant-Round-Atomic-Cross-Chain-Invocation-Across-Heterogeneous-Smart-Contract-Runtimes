package transport

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	succinctproof "github.com/xsmart/relayer/internal/proof/succinct"
)

func attachSuccinctStateImportProof(args map[string]any, family string, chain string, endpoint string, mode string) ([]byte, error) {
	if args == nil {
		return nil, fmt.Errorf("succinct state-import proof requires args")
	}
	var proofBytes []byte
	var ok bool
	envelopeReady := false
	switch mode {
	case "succinct_sp1":
		proofBytes, ok = evidenceBytesFromArgs(args, "sp1_proof", "succinct_proof", "proof")
	case "succinct_risc0":
		proofBytes, ok = evidenceBytesFromArgs(args, "risc0_seal", "succinct_proof", "proof")
	default:
		return nil, fmt.Errorf("unsupported succinct proof mode %q", mode)
	}
	if !ok {
		witnessBytes, witnessOK := evidenceBytesFromArgs(args, "succinct_witness", "zk_witness", "production_witness")
		if !witnessOK {
			return nil, fmt.Errorf("%s requires external succinct proof bytes or a production witness; fixture fallback is disabled", mode)
		}
		generated, err := runSuccinctProver(mode, witnessBytes)
		if err != nil {
			return nil, err
		}
		proofBytes = generated.AdapterProof
		envelopeReady = true
	}
	encodedState, err := json.Marshal(argsExcluding(args,
		"proof",
		"sp1_proof",
		"risc0_seal",
		"succinct_proof",
		"succinct_witness",
		"zk_witness",
		"production_witness",
		"verificationMode",
		"productionProofSource",
	))
	if err != nil {
		return nil, err
	}
	stateHash := crypto.Keccak256Hash(encodedState)
	if strings.EqualFold(strings.TrimSpace(osHashAlg(args)), "sha256") {
		sum := sha256.Sum256(encodedState)
		stateHash = common.BytesToHash(sum[:])
	}
	binding := succinctproof.StateImportBinding{
		ChainID:          crypto.Keccak256Hash([]byte(strings.TrimSpace(family) + ":" + strings.TrimSpace(chain))),
		ContractID:       crypto.Keccak256Hash([]byte(strings.TrimSpace(endpoint))),
		SchemaHash:       crypto.Keccak256Hash([]byte("schema|" + strings.TrimSpace(chain) + "|" + strings.TrimSpace(endpoint))),
		OpID:             common.HexToHash(fixedBytes32FromText(firstNonEmptyString(stringFromArgs(args, "crossChainTxId", "cross_chain_tx_id"), "0"))),
		LockEpoch:        uint64FromArgs(args, "lock_epoch", "lockEpoch"),
		StateVersion:     uint64FromArgs(args, "state_version", "stateVersion"),
		EncodedStateHash: stateHash,
	}
	if binding.LockEpoch == 0 {
		binding.LockEpoch = 1
	}
	if binding.StateVersion == 0 {
		binding.StateVersion = binding.LockEpoch
	}
	envelope := proofBytes
	if !envelopeReady {
		envelope, _, err = succinctproof.BuildProofEnvelope(binding, proofBytes)
		if err != nil {
			return nil, err
		}
	}
	args["proof"] = "0x" + hex.EncodeToString(envelope)
	args["verificationMode"] = mode
	return encodedState, nil
}

type succinctProverOutput struct {
	AdapterProof string `json:"adapter_proof"`
	PublicValues string `json:"public_values"`
	Proof        string `json:"proof"`
	Seal         string `json:"seal"`
	ProveMS      uint64 `json:"prove_ms"`
}

type succinctGeneratedProof struct {
	AdapterProof []byte
	Output       succinctProverOutput
}

func runSuccinctProver(mode string, witnessBytes []byte) (succinctGeneratedProof, error) {
	cmdLine := strings.TrimSpace(os.Getenv("XSMART_SUCCINCT_PROVER_CMD"))
	if mode == "succinct_sp1" && strings.TrimSpace(os.Getenv("XSMART_SP1_HOST_CMD")) != "" {
		cmdLine = strings.TrimSpace(os.Getenv("XSMART_SP1_HOST_CMD"))
	}
	if mode == "succinct_risc0" && strings.TrimSpace(os.Getenv("XSMART_RISC0_HOST_CMD")) != "" {
		cmdLine = strings.TrimSpace(os.Getenv("XSMART_RISC0_HOST_CMD"))
	}
	if cmdLine == "" {
		return succinctGeneratedProof{}, fmt.Errorf("%s requires XSMART_SUCCINCT_PROVER_CMD or backend-specific host command", mode)
	}

	dir := filepath.Join(os.TempDir(), fmt.Sprintf("xsmart-succinct-%d", time.Now().UnixNano()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return succinctGeneratedProof{}, err
	}
	defer os.RemoveAll(dir)

	witnessPath := filepath.Join(dir, "witness.json")
	outPath := filepath.Join(dir, "proof.json")
	if err := os.WriteFile(witnessPath, witnessBytes, 0o600); err != nil {
		return succinctGeneratedProof{}, err
	}

	shell, flag := "sh", "-c"
	if runtime.GOOS == "windows" {
		shell, flag = "powershell.exe", "-Command"
	}
	cmd := exec.Command(shell, flag, cmdLine)
	cmd.Env = append(os.Environ(),
		"XSMART_STATE_IMPORT_WITNESS="+witnessPath,
		"XSMART_SP1_PROOF_OUT="+outPath,
		"XSMART_RISC0_PROOF_OUT="+outPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return succinctGeneratedProof{}, fmt.Errorf("%s prover failed: %w: %s", mode, err, strings.TrimSpace(string(out)))
	}

	raw, err := os.ReadFile(outPath)
	if err != nil {
		return succinctGeneratedProof{}, fmt.Errorf("%s prover did not write output %s: %w", mode, outPath, err)
	}
	var parsed succinctProverOutput
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return succinctGeneratedProof{}, fmt.Errorf("%s prover output decode failed: %w", mode, err)
	}
	adapterProof, ok := bytesFromEvidenceValue(parsed.AdapterProof)
	if !ok {
		return succinctGeneratedProof{}, fmt.Errorf("%s prover output missing adapter_proof", mode)
	}
	return succinctGeneratedProof{AdapterProof: adapterProof, Output: parsed}, nil
}

func osHashAlg(args map[string]any) string {
	if raw, ok := args["hash_algorithm"].(string); ok {
		return raw
	}
	return "keccak256"
}

func uint64FromArgs(args map[string]any, keys ...string) uint64 {
	for _, key := range keys {
		if value := stringFromArgs(args, key); value != "" {
			var out uint64
			_, _ = fmt.Sscanf(value, "%d", &out)
			if out != 0 {
				return out
			}
		}
	}
	return 0
}

func fixedBytes32FromText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return "0x" + hex.EncodeToString(sum[:])
}
