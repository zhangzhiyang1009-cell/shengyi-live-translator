# 声译 · Shengyi Live Translator

一个独立运行的浏览器实时语音转写与翻译工具。支持双语逐字稿、复制与导出、断线自动恢复，以及中英文本地离线互译。

## 功能

- 实时语音识别与 interim/final 双语显示
- 中文、English、粤语、日本語、한국어、Français、Deutsch、Español 识别语言
- 中英文通过本地 CTranslate2 模型离线互译
- 其他语言通过 MyMemory 公共服务在线翻译
- 麦克风授权异常、识别启动超时、识别卡死自动处理
- 持续有声音但 18 秒无识别结果时自动恢复，保留已有逐字稿
- 一键复制、导出双语 TXT

## Windows 免安装版

前往 [Releases](https://github.com/zhangzhiyang1009-cell/shengyi-live-translator/releases) 下载 `Shengyi-Windows-Portable.zip`。

1. 完整解压 ZIP。
2. 双击 `启动声译.bat`。
3. 浏览器打开后，允许麦克风权限并开始说话。

适用于 64 位 Windows 10／11，无需安装 Node.js、Python 或配置 API。语音识别和其他语言翻译仍需联网，中英文互译可离线使用。

## 从源码运行

### 环境要求

- Node.js 22 或更高版本
- Python 3.10 或更高版本
- 最新版 Microsoft Edge 或 Google Chrome

### 安装

```bash
npm install
python -m venv .venv
```

Windows：

```bat
.venv\Scripts\activate
python -m pip install -r requirements.txt
python scripts/download_models.py
```

macOS／Linux：

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
python scripts/download_models.py
```

模型下载脚本使用官方 Argos PM 索引，下载约 164 MB 的 OPUS 中英文模型。未下载模型时，翻译会回退到在线公共服务。

### 启动

```bash
npm run dev
```

打开终端显示的本地地址，默认是 `http://127.0.0.1:5173/`。自定义端口：

```bash
npm run dev -- --host 127.0.0.1 --port 7100
```

构建前端：

```bash
npm run build
```

## 使用注意

- 浏览器语音识别依赖在线识别服务，不是离线语音识别。
- 首次使用请点击地址栏的麦克风图标并选择“允许”。
- 如果浏览器没有权限设置入口，请改用最新版 Edge 或 Chrome。
- 逐字稿只保留在当前页面内存中，刷新或开始新会话会清空；需要保留时请先导出。
- 其他语言的公共翻译服务可能限流，建议需要稳定离线使用时选择中英文互译。

## 项目结构

```text
├── index.html                 # 页面结构
├── src/
│   ├── main.js                # 识别、自动恢复、翻译与导出逻辑
│   └── style.css              # 界面样式
├── server.mjs                 # Vite 开发服务与本地翻译 API
├── offline_translator.py      # CTranslate2 JSON-lines 翻译进程
├── scripts/download_models.py # 官方离线模型下载脚本
└── requirements.txt           # Python 依赖
```

## 第三方模型与许可说明

中英文模型来自 Argos Translate／OPUS-MT，原作者为 Jörg Tiedemann 和 Santhosh Thottingal。原始 OPUS 模型采用 **CC-BY 4.0** 许可。

论文：*OPUS-MT — Building open translation services for the World*，EAMT 2020。

- Argos PM 索引：https://github.com/argosopentech/argospm-index
- CTranslate2：https://github.com/OpenNMT/CTranslate2
- SentencePiece：https://github.com/google/sentencepiece
- 在线备用翻译：https://mymemory.translated.net/
