---
title: "Patterns in Consecutive Odd Numbers"
crumb: "Example Book · Chapter 1"
source: "markdown"
meta:
  - "Est. study time: ~15 minutes"
---

## Overview

Adding consecutive odd numbers produces square numbers. This compact syntax
example shows the visual pattern, states it precisely, and checks it through a
worked example and practice. It also demonstrates every supported directive.

:::callout-key[Prerequisites]
You only need addition and the meaning of a square number.
:::

## 1.1 Growing squares with odd borders

:::callout-intuition[Why odd numbers appear]
Growing an $n$-by-$n$ square to an $(n+1)$-by-$(n+1)$ square adds one row and
one column, with the shared corner counted once. That border has $2n+1$ tiles.
:::

### From the picture to a definition

:::definition[Definition 1.1 — Consecutive odd sum]
Let $S_n=1+3+5+\cdots+(2n-1)$ be the sum of the first $n$ positive odd numbers.
:::

:::lemma[Lemma 1.1 — The next border]
An $n$-by-$n$ square needs $2n+1$ new tiles to become an
$(n+1)$-by-$(n+1)$ square.
:::

:::theorem[Theorem 1.1 — Odd sums are squares]
For every positive integer $n$, $S_n=n^2$.
:::

:::proof[Proof]
The first sum is $S_1=1=1^2$. If $S_n=n^2$, then adding the next odd number gives

$$
S_{n+1}=n^2+(2n+1)=(n+1)^2.
$$

The base case and this step prove the claim for every positive integer.
:::

:::corollary[Corollary 1.1 — Difference of neighbouring squares]
For every positive integer $n$, $(n+1)^2-n^2=2n+1$.
:::

<figure class="fig">
<svg class="fig-hue-2" viewBox="0 0 120 120" width="120" height="120"
     role="img" aria-label="A square with an L-shaped border added on two sides">
<path class="fig-fill" d="M20 20H80V80H20Z"/>
<path class="fig-curve" d="M80 20H100V100H20V80H80Z"/>
</svg>
<figcaption>The L-shaped border adds the next odd number of tiles and turns one square into the next.</figcaption>
</figure>

### A worked calculation

::::example[Example 1.1 — Sum the first four odd numbers]
Find $1+3+5+7$ using the square-number pattern.

:::answer[Answer]
**Answer: $16$.**

1. Count the four odd-number terms, because the theorem uses the number of
   terms as its input.
2. Substitute $n=4$ into $S_n=n^2$, giving $S_4=4^2$.
3. Evaluate the square to obtain $S_4=16$.

Check: direct addition gives $1+3+5+7=16$, the same result.
:::
::::

:::callout-pitfall[Two common mistakes]
Do not use the last odd number, $7$, as the value of $n$; $n$ counts terms.
Also do not add the next border, $9$, after the four requested terms.
:::

:::callout-warning[Where the statement starts]
The theorem is stated for positive integers. If a convention includes an empty
sum at $n=0$, say so explicitly before using that case.
:::

:::callout-tip[Quick check]
After summing the first $n$ odd numbers, take the square root. A whole-number
result of $n$ is a fast check, though it does not replace the derivation.
:::

:::callout-connect[Geometric connection]
The algebraic identity and the growing-square picture express the same fact:
the difference between neighbouring square areas is odd.
:::

:::note[Notation]
The subscript in $S_n$ records how many odd numbers were added.
:::

:::annot[Reading the formula]
In $2n-1$, doubling $n$ and subtracting one generates $1,3,5,\ldots$.
:::

::::problem[Problem 1.1 — The first six odd numbers]{difficulty=easy}
Find $1+3+5+7+9+11$.

:::solution[Solution]
**Answer: $36$.**

1. Count the six terms, since the index in $S_n$ records how many positive odd
   numbers are included.
2. Substitute $n=6$ into the theorem to obtain $S_6=6^2$.
3. Evaluate the square, which gives $S_6=36$.

Check: the partial sums are $1,4,9,16,25,36$, so the sixth sum is indeed $36$.
:::
::::

## Chapter Summary

:::summary[What to remember]
The first $n$ positive odd numbers sum to $n^2$, and the next odd number forms
the border that grows an $n$-by-$n$ square into the next square.
:::

## Mixed Practice

::::problem[Problem M.1 — Recover the number of terms]{difficulty=standard}
A sum of consecutive positive odd numbers equals $81$. How many terms are in
the sum?

:::solution[Solution]
**Answer: $9$ terms.**

1. Use the theorem to translate the sum into the equation $n^2=81$, where $n$
   is the number of terms.
2. Take square roots to get $n=9$ or $n=-9$.
3. Reject $-9$ because a number of terms cannot be negative.

Check: the first nine positive odd numbers sum to $9^2=81$.
:::
::::
