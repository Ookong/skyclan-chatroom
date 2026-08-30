# W03-weekend · 猜大小游戏 v1

> 用时：40-60 分钟 · 难度：⭐⭐⭐ · 前置：W03 三课

---

## 一、本周武功盘点（3 分钟）

- if / elif / else：程序会看情况办事，从上往下、命中即止
- 比较运算符六兄弟 + and / or / not
- 缩进即语法，= 与 == 分家

今天把它们组装成第一个**真正的游戏**。

## 二、提前借一件法宝：random.randint（7 分钟）

游戏要有悬念，得让**电脑自己想一个数**，每次还不一样。这需要 random（随机）法宝：

```python
import random

secret = random.randint(1, 100)
print(secret)
```

### 逐字拆解 `random.randint(1, 100)`

| 部件 | 作用 |
|---|---|
| `import random` | 放在第一行：把法宝盒搬进来（Python 自带，零安装） |
| `random.randint` | 法宝全名：随机整数 |
| `(1, 100)` | 范围：1 到 100，两头都包含 |

多 Run 几次：每次的数都不一样，这就是随机。也可以在 Shell 区直接试 `>>> random.randint(1, 6)`，每回车一次扔一次骰子。

两件事说清楚：

1. **random 是 Python 标准库**——装 Python 就送，import 一下就能用，什么都不用装
2. 今天只当**黑盒法宝**用。它还有一堆玩法（骰子、抽签、洗牌），**第 11 周「随机与游戏」正式开课**，本周只借这一招

## 三、搭游戏（20 分钟）

> 📁 项目存 `~/learning-homework/W03/W03-project.py`。

新建 `guess_game.py`，亲手敲：

```python
import random

print("=== High-Low Guess v1 ===")

secret = random.randint(1, 100)
print("(debug mode: the answer is", secret, ")")

guess = int(input("I picked a number 1-100. Your guess? "))

if guess > secret:
    print("Too high! It was", secret)
elif guess < secret:
    print("Too low! It was", secret)
else:
    print("First try! You have leader material")
```

运行几局，体会结构：

- `secret`：电脑心里的数，藏好
- 调试模式那行是**诚实模式**——先打印答案方便测试，游戏正式发布时删掉它
- 三个分支覆盖所有可能：大了 / 小了 / 猜中，必有其一、只走其一

**常见翻车点：**

- import random 忘写或没放第一行 → `NameError: name 'random' is not defined`
- 输入的不是数字（手滑敲了字母）→ `ValueError`——W02-L01 的老坑，正常，重新 Run
- 改范围时只改了一个 100 忘了另一个 → 谜题范围和提示语对不上

**改造练习（自己动手）：**

1. 把三处揭底 `print("...", secret)` 改成 f-string 版：`print(f"Too high! The answer is {secret}")`
2. 缩小战场：范围改成 1-10，猜中概率大增，找家人对战

## 四、升级玩法（15 分钟）

**皮肤一：猫武士版**——提示语全换成森林用语（「猎物的气味比你猜的更淡」「猎物就在更近的地方」），范围改成 1-20 当「猎物数量」。

**皮肤二：商店版**——呼应 ThawPaw 的贪吃蛇商店：程序随机想一个价格（1-50 元），你来猜，大了小了照旧提示。

**立个 flag：** 现在只能猜一次就揭底，不过瘾对吧？因为我们还不会「重复」。W04 学循环、W05 学 while 之后，这个游戏会进化成「猜到为止 + 限 5 次 + 计分 + 再来一局」的完整版。好课程埋伏笔，W05 见。

## 五、验收标准（自助验收）

- 三位家人各玩一局（你当主持人，记录谁最接近）
- 调试模式开着能对答案；删掉调试行后正常运行不报错
- 你能指着代码说清：哪个变量是答案、哪个分支管「大了」、为什么必有其一
- f-string 改造完成，三处揭底都换了新写法
- 至少换过一版皮肤 ✅

## 六、W03 全周自查

- [ ] L01：if 四件套（if / 条件 / 冒号 / 缩进）张口就来
- [ ] L02：elif 链会排顺序，趟过顺序陷阱
- [ ] L03：and / or / not 口算真假，评定器跑通
- [ ] 周末：猜大小 v1 完成，给家人玩过，换过皮肤
- [ ] 随机法宝 random.randint 会借会用，知道第 11 周正式学

W03 毕业 🎓 → 进入 W04「让程序重复干活」。程序学会重复，才是真正的干将：画 100 层楼梯、九九乘法表，都不在话下。
