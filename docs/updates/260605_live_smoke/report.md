# minicode Live Smoke Report

Status: PASS
Provider: https://api.siliconflow.cn/v1
Model: deepseek-ai/DeepSeek-V3.2
API key env: MINICODE_API_KEY
Project: /home/gujing/code/minicode

## Cases

### plain-text

Status: PASS
Session: session_mq0zpz6r_0001_0r1bbia
Tool calls: (none)
Produced files: (none)
Final message: plain text smoke ok

### tool-call

Status: PASS
Session: session_mq0zq1fr_0002_01b9yzp
Tool calls: write
Produced files: live-smoke-tool.md
Final message: I've successfully created `live-smoke-tool.md` in the workspace with the required content. The file contains the exact phrase "Live smoke tool-call smoke" as requested. The file is 207 characters long and summarizes its own purpose as a ...

### temporary-script

Status: PASS
Session: session_mq0zqbzx_0003_0dgxqfq
Tool calls: shell, read, write, shell, read
Produced files: .minicode/tmp/live-smoke-evidence.md
Final message: I have successfully executed the live smoke test by creating `.minicode/tmp/live-smoke-evidence.md` with a local shell command. The file contains the required lines: `Command:`, `Source:`, and `Access time:`, along with the output from t...
