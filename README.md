# WetFlow

面向湿实验的工作流 Agent，集成工具调用、人工审批、工业数据记录和生物过程建模。

支持 Monod 批次模拟、生长曲线拟合、CSV 数据集、结果下载及预测与实验关联。

## 运行

需要 Node.js ≥ 22.19 和 Python 3。

```sh
npm ci
npm run build
npm start
```

打开 http://127.0.0.1:4310 。数值建模在本地运行；对话模型可在界面中配置。
