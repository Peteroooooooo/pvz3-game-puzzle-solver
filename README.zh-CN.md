# PVZ3 游戏谜题求解器

这是一个面向 **Plants vs. Zombies 3** 的静态网页谜题工具，重点覆盖倒水求解、加料模拟和反馈推演。

在线演示：[https://peteroooooooo.github.io/pvz3-game-puzzle-solver/](https://peteroooooooo.github.io/pvz3-game-puzzle-solver/)

## 仓库内容

- `pvz3_water_sort_solver.html` - 支持实机加料规则的倒水求解器
- `water_solver_engine.js` - 可测试的最短路、满瓶屏蔽与随机加料策略核心
- `water_solver_worker.js` - 浏览器后台求解 Worker
- `seeded_simulation_test.js` - 固定补料种子的可复现策略 A/B 测试
- `pvz3_decode_solver.html` - 配套的解码 / 反馈推演工具
- `assets/pvz3/` - 页面使用的本地素材

## 特点

- 支持 PVZ3 风格的完成后加料机制
- 满瓶屏蔽策略会比较立即清瓶与主动堆满保护瓶的路线，并精确枚举建模范围内的加料结果
- 静态模式使用完整状态搜索给出可验证的最短路线；内置示例由旧版 15 步降至已证明最短的 13 步
- 加料模式分别显示必胜策略状态、期望步数上下界和剩余最优差距；只有上下界收敛时才标记全局期望最优
- 支持 4 秒、15 秒和 60 秒搜索预算，计算在 Web Worker 中执行
- 解码器默认严格反馈策略：全部 11,880 种不重复的合法真解，在正确槽位永久锁定时均保证 4 轮内完成
- 纯浏览器运行，无需安装
- 适合 GitHub Pages 静态部署

## 验证

```bash
node smoke_test.js
node water_solver_engine_test.js
node seeded_simulation_test.js
```

内置示例的 2,048 个固定补料种子测试中，最快清瓶基线和完整策略均为 100% 通关；完整策略由平均 20.844 步降至 20.598 步（减少 0.246 步，约 1.18%），观测最坏值由 23 步降至 22 步。盲目追求更多满瓶护盾反而会升至平均 23 步，因此完整策略会同时权衡布局成本和后续随机风险。

## 文案说明

- [English README](./README.md)
- [文案审查](./docs/copy-review.md)

## 说明

这是粉丝向项目，与 PopCap、EA 或官方《植物大战僵尸》团队无关。
