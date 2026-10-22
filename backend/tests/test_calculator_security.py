import math

import pytest

from safe_calculator import evaluate_arithmetic
from tool import calculator


@pytest.mark.parametrize("expression,expected", [
    ("2*(3+4)", 14), (" -3 + +5 ", 2), ("7/2", 3.5),
    ("7//2 + 7%2", 4), ("2**10", 1024), ("pow(2, 8)", 256),
    ("math.sqrt(16)", 4), ("math.sin(math.pi/2)", 1),
    ("math.log(math.e)", 1), ("abs(-4)", 4), ("round(1.234, 2)", 1.23),
    ("min(3, -2, 4)", -2), ("max([1, 5, 2])", 5),
    ("sum((1, 2, 3), 4)", 10), ("math.factorial(5)", 120),
    ("math.comb(10, 3)", 120), ("math.perm(5, 2)", 20),
    ("math.prod([2, 3, 4])", 24), ("math.fsum([0.1, 0.2])", 0.3),
    ("math.dist([0, 0], [3, 4])", 5), ("math.gcd(12, 18)", 6),
    ("math.lcm(12, 18)", 36), ("math.isqrt(17)", 4),
    ("math.pow(4, 0.5)", 2), ("math.tau", math.tau),
])
def test_safe_arithmetic(expression, expected):
    assert evaluate_arithmetic(expression) == pytest.approx(expected)


@pytest.mark.parametrize("expression", [
    "", "2 +", "2; 3", "import os", "__import__('os').getcwd()",
    "().__class__.__base__.__subclasses__()", "math.__dict__", "math.sqrt.__globals__",
    "[1][0]", "[x for x in (1, 2)]", "(lambda: 1)()", "(x := 1)",
    "1 if True else 0", "1 < 2", "True", "None", "'hello'", "1j",
    "math", "open('file')", "eval('1')", "exec('1')", "math.unknown(1)",
    "math.sqrt()", "math.sqrt(1, 2)", "math.sqrt(x=4)", "min()", "sum(1)",
    "math.lcm(0.0)", "sum([[1]])", "max(*[1, 2])", "1 << 100",
    "1/0", "1//0", "1%0", "math.sqrt(-1)", "(-1)**0.5", "1e309",
    "1e308*1e308", "math.exp(1000)", "math.factorial(1000000000)",
    "math.comb(1000000000, 5)", "math.perm(1000000000)",
    "9**999999999", "math.pow(2, 999999999)", "pow(2, 1001)",
    "2**1023 * 2**1023", "math.prod([2**1000, 2**1000])",
    "round(1.2, 999999999)", "9" * 310, "1" * 1025,
    "-" * 30 + "1", "(" * 300 + "1" + ")" * 300,
    "sum([" + ",".join(["1"] * 33) + "])",
    "+".join(["1"] * 70),
])
def test_unsafe_or_unbounded_expressions_are_rejected(expression):
    with pytest.raises((ValueError, TypeError, ZeroDivisionError, OverflowError)):
        evaluate_arithmetic(expression)
    assert calculator.invoke({"expression": expression}).startswith("Calculation error:")


def test_calculator_tool_contract():
    assert calculator.name == "calculator"
    assert set(calculator.args) == {"expression"}
    assert calculator.invoke({"expression": "2*(3+4)"}) == "14"
    assert calculator.invoke({"expression": "math.sqrt(16)"}) == "4.0"
