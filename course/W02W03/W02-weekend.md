# W02-weekend · 名字实验室 + 单价订单计算器

> 用时：40-60 分钟 · 难度：⭐⭐⭐ · 前置：W02 三课

---

## 一、本周武功盘点（3 分钟）

- 类型与转换：int / float / str / type()，"2026" ≠ 2026
- 字符串功夫：len / upper / lower / strip / replace / 切片 / in
- f-string：花括号填空 + :.2f / :, / 对齐

周末两个项目把它们全部用上。规矩不变：**全部手敲，不复制粘贴。**

## 二、项目 A：名字实验室（25 分钟）

> 📁 项目存 `~/learning-homework/W02/W02-project.py`。

新建 `name_lab.py`。目标：用户输入姓和名，实验室把这个名字玩出花。

**要求打印 6 行报告：**

1. 完整姓名（姓 + 名 拼接）
2. 大写喊名（英文变大写；中文原样——没大小写）
3. 名字长度（len）
4. 名字首字（索引 [0]）
5. 姓氏打星：完整姓名里把姓氏替换成 *（replace）
6. 侦探判断：名字里是否含字母 a（in，输出 True / False）

最后再用 f-string 打一行居中的汇报卡（:^20）。

**提示三条：**

- 先把 姓、名 装进两个变量，完整姓名 = 两个变量拼接，存第三个变量
- 判断含 a 前，先 lower() 统一大小写（不然大写 A 会漏网）
- 中文姓名照样能玩：长度、首字、替换、侦探全有效

参考代码（先自己写，卡住 10 分钟以上再看）：

```python
family = input("Your family name? ")
given = input("Your given name? ")

full = family + given

print("Full name:", full)
print("SHOUT it out:", full.upper())
print("Name length:", len(full))
print("First letter:", full[0])
print("Family name starred:", full.replace(family, "*"))
print("Contains letter a:", "a" in full.lower())

title = "Name Lab Report Complete"
print(f"{title:^20}")
```

**常见翻车点：**

- replace(family, "*") 换的是**所有**匹配到的姓氏——如果名字里恰好也有同字，会一起变星，正常现象
- 中文字符也按 1 个字符计，汇报卡嫌窄就把 :^20 调成 :^30

**玩性彩蛋（选玩）：** 切片还能倒着切——`full[::-1]` 得到倒着念的名字，超纲招式，照抄体验一下就行，原理 W06 讲列表时回头见。

## 三、项目 B：单价订单计算器（20 分钟）

新建 `order.py`。这是 W01 计算器的进化版：一张像样的**小票**。

**要求：**

1. 问两样商品：各问商品名、单价（float）、数量（int），共 6 个 input
2. 每样一行明细：f-string + :.2f
3. 合计一行：两样小计相加，用 :, 和 :.2f
4. 问实付金额，最后打印找零一行

**目标小票长相（数值自定）：**

```text
=== Family Corner Store ===
Cat food x 3 = 118.50 yuan
Cat treats x 10 = 45.00 yuan
Total: 163.50 yuan
Paid 200 yuan, change: 36.50 yuan
```

**提示三条：**

- 明细行参考：`print(f"{n1} x {c1} = {p1 * c1:.2f} yuan")`
- 合计 = 两个「单价 × 数量」相加，再进 f-string
- 想看千位分隔出场，就把某样单价输大点（比如猫抓板 199 元，买 100 个）——数字越大，`,` 越好看
- 实付不够时会打出负数找零——现在先不管，W03 学了 if 就能拦住它（好伏笔）

## 四、验收标准（自助验收）

- 找一位家人当用户完整跑一遍，输入真实数据
- 名字实验室 7 行输出（6 行报告 + 汇报卡）无报错；中文名、英文名各试一次
- 小票四舍五入到分，格式工整，找零算得对
- 输入里故意混一次带空格的商品名，看小票是否还能看（学过 strip 的你懂的）
- 两位学员互相演示，给对方的报告卡 / 小票截个图留念 ✅

## 五、W02 全周自查

- [ ] L01：分得清 int / float / str，会 type() 和转换三兄弟，踩过 ValueError
- [ ] L02：五招基本功 + 切片 + in 全用过，能算对 s[1:3]
- [ ] L03：会 f-string 填空和四种格式化造型
- [ ] 周末两个项目完成并给家人演示过

W02 毕业 🎓 → 进入 W03「让程序做决定」。预告：学了三周，程序还只会从头到尾直着走——下周教它**看情况办事**。
