def fibonacci(n):
    """
    计算第 n 个斐波那契数（从 0 开始计数：0, 1, 1, 2, 3, 5...）
    使用迭代法，时间复杂度 O(n)，空间复杂度 O(1)
    """
    if n < 0:
        raise ValueError("n 必须是非负整数")
    if n == 0:
        return 0
    if n == 1:
        return 1

    a, b = 0, 1
    for _ in range(2, n + 1):
        a, b = b, a + b
    return b


def fibonacci_recursive(n, memo=None):
    """
    使用带记忆化的递归法计算第 n 个斐波那契数
    """
    if memo is None:
        memo = {}
    if n in memo:
        return memo[n]
    if n < 2:
        return n
    memo[n] = fibonacci_recursive(n - 1, memo) + fibonacci_recursive(n - 2, memo)
    return memo[n]


if __name__ == "__main__":
    n = 50

    # 方法1：迭代法
    result_iter = fibonacci(n)
    print(f"第 {n} 个斐波那契数（迭代法）: {result_iter}")

    # 方法2：记忆化递归
    result_recur = fibonacci_recursive(n)
    print(f"第 {n} 个斐波那契数（递归法）: {result_recur}")

    # 额外：打印前 20 个斐波那契数
    print("\n前 20 个斐波那契数列:")
    fib_sequence = [fibonacci(i) for i in range(20)]
    for i, val in enumerate(fib_sequence):
        print(f"F({i}) = {val}")
