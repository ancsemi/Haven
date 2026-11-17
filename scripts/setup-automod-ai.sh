#!/usr/bin/env bash
# ==============================================================================
# Haven AutoMod Quarantine: hardware-Aware AI & Plugin Setup
# ==============================================================================
# Automatically detects GPU VRAM, system RAM, CPU cores, and active CLI
# subscriptions, selects the optimal local or cloud AI configuration, optionally
# installs/configures Ollama + pulls the best model for this machine, and writes
# config/automod-local.json so Haven clients auto-detect it out of the box.
#
# Usage:
#   ./scripts/setup-automod-ai.sh              # Auto-detect & configure
#   ./scripts/setup-automod-ai.sh --pull       # Also pull the recommended Ollama model if none exists
#   ./scripts/setup-automod-ai.sh --install-ollama --pull  # Install Ollama if missing + pull model
#   ./scripts/setup-automod-ai.sh --dry-run    # Print hardware profile & recommendation without writing
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../server.js" ]; then
  HAVEN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "$SCRIPT_DIR/plugins/AutoModQuarantine.plugin.js" ]; then
  HAVEN_ROOT="$SCRIPT_DIR"
else
  HAVEN_ROOT="$(pwd)"
fi

DO_PULL=0
DO_INSTALL_OLLAMA=0
DRY_RUN=0
CUSTOM_MODEL=""
TARGET_DIR=""

for arg in "$@"; do
  case "$arg" in
    --pull) DO_PULL=1 ;;
    --install-ollama) DO_INSTALL_OLLAMA=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --model=*) CUSTOM_MODEL="${arg#*=}" ;;
    --help|-h)
      echo "Usage: $0 [haven_dir] [--pull] [--install-ollama] [--model=NAME] [--dry-run]"
      exit 0
      ;;
    -*)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      TARGET_DIR="$arg"
      ;;
  esac
done

if [ -n "$TARGET_DIR" ] && [ -d "$TARGET_DIR" ]; then
  HAVEN_ROOT="$(cd "$TARGET_DIR" && pwd)"
fi

echo "========================================================"
echo "  Haven AutoMod AI: hardware & Subscription Detector"
echo "========================================================"

# ------------------------------------------------------------------------------
# 1. Detect OS, CPU, and System RAM
# ------------------------------------------------------------------------------
OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
CPU_CORES=2
RAM_MB=4096

if [ "$OS_NAME" = "Linux" ]; then
  CPU_CORES="$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 2)"
  RAM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 4194304)"
  RAM_MB=$(( RAM_KB / 1024 ))
elif [ "$OS_NAME" = "Darwin" ]; then
  CPU_CORES="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  RAM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 8589934592)"
  RAM_MB=$(( RAM_BYTES / 1024 / 1024 ))
fi
RAM_GB=$(( (RAM_MB + 512) / 1024 ))

# ------------------------------------------------------------------------------
# 2. Detect GPU Vendor, Model, and VRAM
# ------------------------------------------------------------------------------
GPU_VENDOR="cpu"
GPU_NAME="CPU Only"
VRAM_MB=0

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits >/dev/null 2>&1; then
  GPU_VENDOR="nvidia"
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 | xargs)"
  VRAM_MB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1 | awk '{print int($1)}')"
elif [ "$OS_NAME" = "Linux" ] && compgen -G "/sys/class/drm/card*/device/mem_info_vram_total" >/dev/null 2>&1; then
  # AMD ROCm / amdgpu sysfs VRAM detection (pick largest discrete GPU)
  MAX_VRAM_BYTES=0
  for vfile in /sys/class/drm/card*/device/mem_info_vram_total; do
    val="$(cat "$vfile" 2>/dev/null || echo 0)"
    if [ "$val" -gt "$MAX_VRAM_BYTES" ]; then
      MAX_VRAM_BYTES="$val"
    fi
  done
  VRAM_MB=$(( MAX_VRAM_BYTES / 1024 / 1024 ))
  if [ "$VRAM_MB" -gt 1024 ]; then
    GPU_VENDOR="amd"
    if command -v lspci >/dev/null 2>&1; then
      GPU_NAME="$(lspci | grep -iE 'vga|3d|display' | grep -iE 'amd|ati|radeon' | head -n1 | sed -E 's/^[0-9a-fA-F:.]+ [^:]+: //')"
    else
      GPU_NAME="AMD Radeon GPU"
    fi
  fi
elif [ "$OS_NAME" = "Darwin" ] && [ "$ARCH_NAME" = "arm64" ]; then
  GPU_VENDOR="apple"
  GPU_NAME="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Apple Silicon Unified Memory')"
  # Apple Silicon shares ~70% of unified RAM with Metal GPU
  VRAM_MB=$(( RAM_MB * 70 / 100 ))
fi

VRAM_GB=$(( (VRAM_MB + 512) / 1024 ))

echo "• System   : $OS_NAME ($ARCH_NAME), ${CPU_CORES} CPU cores, ${RAM_GB} GB RAM"
echo "• Graphics : $GPU_NAME (${GPU_VENDOR^^}, ~${VRAM_GB} GB VRAM)"

# ------------------------------------------------------------------------------
# 3. Select Hardware Tier & Ideal Local Model (Qwen 3.8 / 3.6 MoE / 3.5 & Granite 4.2 / 4 MoE)
# ------------------------------------------------------------------------------
HW_TIER="cpu-light"
RECOMMENDED_MODEL="qwen3.5:0.8b"
TIER_REASON="Low-resource CPU/VPS (<8 GB RAM): Qwen 3.5 0.8B (~800 MB RAM) or granite4:1b-h"

if [ "$VRAM_MB" -ge 20000 ]; then
  HW_TIER="gpu-ultra-moe"
  RECOMMENDED_MODEL="qwen3.6:35b-a3b"
  TIER_REASON="Workstation/Enthusiast GPU (${VRAM_GB} GB VRAM): Qwen 3.6 35B-A3B MoE (35B total / 3B active per token, or qwen3.8:27b)"
elif [ "$VRAM_MB" -ge 10000 ]; then
  HW_TIER="gpu-high"
  RECOMMENDED_MODEL="granite4.2:8b"
  TIER_REASON="High-VRAM GPU (${VRAM_GB} GB VRAM): Granite 4.2 8B or Qwen 3.5 9B security & reasoning model"
elif [ "$VRAM_MB" -ge 5500 ]; then
  HW_TIER="gpu-mid-moe"
  RECOMMENDED_MODEL="granite4:7b-a1b-h"
  TIER_REASON="Mid-range GPU (${VRAM_GB} GB VRAM): Granite 4 Hybrid MoE (7B total / 1B active per token) or qwen3.5:4b"
elif [ "$VRAM_MB" -ge 2500 ]; then
  HW_TIER="gpu-entry"
  RECOMMENDED_MODEL="granite4.2:3b"
  TIER_REASON="Entry GPU (${VRAM_GB} GB VRAM): Granite 4.2 3B / Qwen 3.5 2B (~2 GB VRAM)"
elif [ "$RAM_MB" -ge 48000 ] && [ "$CPU_CORES" -ge 8 ]; then
  HW_TIER="cpu-server-moe"
  RECOMMENDED_MODEL="qwen3.6:35b-a3b"
  TIER_REASON="High-RAM CPU server (${RAM_GB} GB RAM, ${CPU_CORES} cores): Qwen 3.6 35B-A3B MoE (35B total / only 3B active per token)"
elif [ "$RAM_MB" -ge 7500 ]; then
  HW_TIER="cpu-moe"
  RECOMMENDED_MODEL="granite4:7b-a1b-h"
  TIER_REASON="CPU-only (${RAM_GB} GB RAM): Granite 4 Hybrid MoE (7B total / only 1B active per token) for 7B quality at 1B CPU speed"
fi

if [ -n "$CUSTOM_MODEL" ]; then
  RECOMMENDED_MODEL="$CUSTOM_MODEL"
fi

echo "• Tier     : $HW_TIER ($TIER_REASON)"

# ------------------------------------------------------------------------------
# 4. Check Ollama Status, Installed Models, and Subscriptions
# ------------------------------------------------------------------------------
if ! command -v ollama >/dev/null 2>&1 && [ "$DO_INSTALL_OLLAMA" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "• Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi
if command -v ollama >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ] && ! curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "• Starting Ollama..."
  (sudo -n systemctl start ollama 2>/dev/null || (nohup ollama serve >/dev/null 2>&1 &)) || true
  for _ in $(seq 1 20); do curl -fsS --max-time 1 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi

OLLAMA_RUNNING=0
INSTALLED_MODELS=()
ACTIVE_MODEL=""

if curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  OLLAMA_RUNNING=1
  if command -v node >/dev/null 2>&1; then
    mapfile -t INSTALLED_MODELS < <(curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags | node -e '
      let d = "";
      process.stdin.on("data", c => d += c);
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(d);
          for (const m of (j.models || [])) if (m.name) console.log(m.name);
        } catch {}
      });
    ')
  fi
fi

CHAT_MODELS=()
for m in ${INSTALLED_MODELS[@]+"${INSTALLED_MODELS[@]}"}; do case "$m" in *embed*|*minilm*|*bge-*) ;; *) CHAT_MODELS+=("$m") ;; esac; done
for m in ${CHAT_MODELS[@]+"${CHAT_MODELS[@]}"}; do if [ "$m" = "$RECOMMENDED_MODEL" ]; then ACTIVE_MODEL="$m"; fi; done
if [ -z "$ACTIVE_MODEL" ] && [ "$OLLAMA_RUNNING" -eq 1 ] && [ "$DO_PULL" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "• Pulling $RECOMMENDED_MODEL (one-time download)..."
  ollama pull "$RECOMMENDED_MODEL" && ACTIVE_MODEL="$RECOMMENDED_MODEL" && INSTALLED_MODELS+=("$RECOMMENDED_MODEL")
fi
if [ -z "$ACTIVE_MODEL" ] && [ -z "$CUSTOM_MODEL" ] && [ "${#CHAT_MODELS[@]}" -gt 0 ]; then
  ACTIVE_MODEL="${CHAT_MODELS[0]}"
  echo "  Using installed model $ACTIVE_MODEL. Re-run with --pull to download the recommended $RECOMMENDED_MODEL."
fi
if [ -z "$ACTIVE_MODEL" ]; then
  ACTIVE_MODEL="$RECOMMENDED_MODEL"
  echo "  Tip: Run 'ollama pull $RECOMMENDED_MODEL' (or re-run with --pull) to download it."
fi
[ "$OLLAMA_RUNNING" -eq 1 ] && echo "• Ollama   : Running on http://127.0.0.1:11434 (models: ${INSTALLED_MODELS[*]:-none})" || echo "• Ollama   : Not running. Re-run with --install-ollama --pull, or get it at https://ollama.com"
echo "• Selected : $ACTIVE_MODEL"
SUB_HINTS=()
if curl -fsS --max-time 1 http://127.0.0.1:41701/v1/models >/dev/null 2>&1; then
  SUB_HINTS+=("AGY Gateway active on http://127.0.0.1:41701/v1/chat/completions")
fi
if command -v gcloud >/dev/null 2>&1; then
  SUB_HINTS+=("gcloud CLI detected: run 'gcloud auth print-access-token' for a Gemini Bearer token")
fi

if [ "${#SUB_HINTS[@]}" -gt 0 ]; then
  echo "• Detected AI tools:"
  for h in "${SUB_HINTS[@]}"; do
    echo "    - $h"
  done
fi

# ------------------------------------------------------------------------------
# 5. Write config/automod-local.json & Sync Plugin if needed
# ------------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "========================================================"
  echo "Dry-run complete. Recommended model: $ACTIVE_MODEL ($HW_TIER)"
  exit 0
fi

mkdir -p "$HAVEN_ROOT/config" "$HAVEN_ROOT/plugins"

SRC_PLUGIN="$SCRIPT_DIR/plugins/AutoModQuarantine.plugin.js"
[ -f "$SRC_PLUGIN" ] || SRC_PLUGIN="$SCRIPT_DIR/../plugins/AutoModQuarantine.plugin.js"
if [ -f "$SRC_PLUGIN" ] && [ "$(cd "$(dirname "$SRC_PLUGIN")" && pwd)" != "$(cd "$HAVEN_ROOT/plugins" && pwd)" ]; then
  cp -f "$SRC_PLUGIN" "$HAVEN_ROOT/plugins/AutoModQuarantine.plugin.js"
  chmod 644 "$HAVEN_ROOT/plugins/AutoModQuarantine.plugin.js"
  echo "• Installed plugin to $HAVEN_ROOT/plugins/AutoModQuarantine.plugin.js"
fi

PROFILE_PATH="$HAVEN_ROOT/config/automod-local.json"
MODELS_JSON="[]"
if command -v node >/dev/null 2>&1 && [ "${#INSTALLED_MODELS[@]}" -gt 0 ]; then
  MODELS_JSON="$(printf '%s\n' "${INSTALLED_MODELS[@]}" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => console.log(JSON.stringify(d.trim().split("\n").filter(Boolean))));
  ')"
fi

cat > "$PROFILE_PATH" <<EOF
{
  "generatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "recommendedProvider": "ollama",
  "recommendedEndpoint": "http://127.0.0.1:11434/v1/chat/completions",
  "recommendedModel": "$ACTIVE_MODEL",
  "ollamaRunning": $([ "$OLLAMA_RUNNING" -eq 1 ] && echo "true" || echo "false"),
  "installedModels": $MODELS_JSON,
  "hardware": {
    "os": "$OS_NAME",
    "arch": "$ARCH_NAME",
    "cpuCores": $CPU_CORES,
    "ramGb": $RAM_GB,
    "gpuVendor": "$GPU_VENDOR",
    "gpu": "$GPU_NAME",
    "vramGb": $VRAM_GB,
    "tier": "$HW_TIER",
    "reason": "$TIER_REASON"
  }
}
EOF

echo "• Wrote hardware & model profile to $PROFILE_PATH"
echo "========================================================"
if ! grep -qs "/api/automod/scan" "$HAVEN_ROOT/src/routes/automodRelay.js"; then
  echo "⚠️  This Haven build has no AutoMod engine, so it can't sweep links with the local model yet."
  echo "   Update Haven to a version that includes src/routes/automodRelay.js, then re-run this script."
  exit 0
fi
echo "✅ AutoMod AI setup complete. No Haven restart needed:"
echo "   Haven now sweeps every new link with $ACTIVE_MODEL on this machine,"
echo "   one at a time, and unloads the model when the queue is empty."
echo "   Moderators who enable AutoMod Quarantine use it automatically."
echo "========================================================"
