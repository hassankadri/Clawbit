"""Bounded arithmetic interpreter. Never compiles or executes Python code."""

import ast
import math
import operator

MAX_EXPRESSION_LENGTH = 1024
MAX_AST_NODES = 128
MAX_AST_DEPTH = 24
MAX_INTEGER_BITS = 1024
MAX_EXPONENT = 1000
MAX_ARGUMENTS = 32

_CONSTANTS = {"pi": math.pi, "e": math.e, "tau": math.tau}
_MATH_FUNCTIONS = {
    "sqrt": math.sqrt, "cbrt": math.cbrt,
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "asin": math.asin, "acos": math.acos, "atan": math.atan, "atan2": math.atan2,
    "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh,
    "asinh": math.asinh, "acosh": math.acosh, "atanh": math.atanh,
    "log": math.log, "log2": math.log2, "log10": math.log10, "log1p": math.log1p,
    "exp": math.exp, "exp2": math.exp2, "expm1": math.expm1,
    "degrees": math.degrees, "radians": math.radians,
    "floor": math.floor, "ceil": math.ceil, "trunc": math.trunc,
    "fabs": math.fabs, "fmod": math.fmod, "remainder": math.remainder,
    "copysign": math.copysign, "hypot": math.hypot, "dist": math.dist,
    "erf": math.erf, "erfc": math.erfc, "gamma": math.gamma, "lgamma": math.lgamma,
    "isqrt": math.isqrt, "gcd": math.gcd, "factorial": math.factorial,
    "comb": math.comb, "perm": math.perm, "fsum": math.fsum,
}
_BINARY = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
}


def _number(value):
    if type(value) not in (int, float):
        raise ValueError("Only real numbers are supported.")
    if isinstance(value, int):
        if value.bit_length() > MAX_INTEGER_BITS:
            raise ValueError("Integer magnitude exceeds the calculation limit.")
    elif not math.isfinite(value):
        raise ValueError("The result must be finite.")
    return value


def _multiply(left, right):
    if isinstance(left, int) and isinstance(right, int):
        if left and right and left.bit_length() + right.bit_length() - 1 > MAX_INTEGER_BITS:
            raise ValueError("Integer magnitude exceeds the calculation limit.")
    return _number(left * right)


def _power(base, exponent):
    _number(base)
    _number(exponent)
    if abs(exponent) > MAX_EXPONENT:
        raise ValueError("Exponent exceeds the calculation limit.")
    if isinstance(base, int) and isinstance(exponent, int) and exponent > 0:
        if abs(base) > 1 and exponent * math.log2(abs(base)) >= MAX_INTEGER_BITS:
            raise ValueError("Integer magnitude exceeds the calculation limit.")
    return _number(base ** exponent)


def _sequence(value):
    if not isinstance(value, (list, tuple)):
        raise ValueError("This function needs a list or tuple of numbers.")
    return [_number(item) for item in value]


def _call(name, args):
    if name in ("sum", "math.prod"):
        if not 1 <= len(args) <= (2 if name == "sum" else 1):
            raise ValueError("Invalid number of function arguments.")
        result = _number(args[1]) if len(args) == 2 else (0 if name == "sum" else 1)
        for value in _sequence(args[0]):
            result = _number(result + value) if name == "sum" else _multiply(result, value)
        return result
    if name in ("min", "max"):
        values = _sequence(args[0]) if len(args) == 1 else [_number(item) for item in args]
        return (min if name == "min" else max)(values)
    if name == "math.lcm":
        result = 1
        for value in args:
            _number(value)
            if type(value) is not int:
                raise ValueError("Least common multiple requires integers.")
            result = _multiply(result // math.gcd(result, value), value) if result and value else 0
        return abs(result)
    if name in ("math.pow", "pow"):
        if len(args) != 2:
            raise ValueError("Power needs two arguments.")
        result = _power(*args)
        return _number(float(result)) if name == "math.pow" else result
    if name in ("math.fsum", "math.dist"):
        args = [_sequence(value) for value in args]
    else:
        args = [_number(value) for value in args]
    if name in ("math.factorial", "math.perm", "math.comb"):
        limit = 1000 if name == "math.comb" else 170
        if any(type(value) is not int or not 0 <= value <= limit for value in args):
            raise ValueError("Combinatorial argument exceeds the calculation limit.")
    if name == "round" and len(args) > 1 and abs(args[1]) > MAX_EXPONENT:
        raise ValueError("Rounding precision exceeds the calculation limit.")
    function = {"abs": abs, "round": round}.get(name)
    if function is None:
        function = _MATH_FUNCTIONS[name.removeprefix("math.")]
    return _number(function(*args))


def evaluate_arithmetic(expression: str):
    if not isinstance(expression, str) or not expression.strip():
        raise ValueError("Enter a math expression.")
    if len(expression) > MAX_EXPRESSION_LENGTH:
        raise ValueError("Expression is too long.")
    try:
        tree = ast.parse(expression.strip(), mode="eval")
    except (SyntaxError, RecursionError) as exc:
        raise ValueError("Invalid math expression.") from exc
    pending = [(tree, 0)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if count > MAX_AST_NODES or depth > MAX_AST_DEPTH:
            raise ValueError("Expression is too complex.")
        pending.extend((child, depth + 1) for child in ast.iter_child_nodes(node))

    def visit(node):
        if isinstance(node, ast.Constant):
            return _number(node.value)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = _number(visit(node.operand))
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp):
            left, right = _number(visit(node.left)), _number(visit(node.right))
            if isinstance(node.op, ast.Pow):
                return _power(left, right)
            if isinstance(node.op, ast.Mult):
                return _multiply(left, right)
            if type(node.op) in _BINARY:
                return _number(_BINARY[type(node.op)](left, right))
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            if node.value.id == "math" and node.attr in _CONSTANTS:
                return _CONSTANTS[node.attr]
        if isinstance(node, ast.Call):
            if node.keywords or len(node.args) > MAX_ARGUMENTS:
                raise ValueError("Keyword arguments and large argument lists are not supported.")
            name = ""
            if isinstance(node.func, ast.Name):
                if node.func.id in {"abs", "round", "min", "max", "sum", "pow"}:
                    name = node.func.id
            elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                if node.func.value.id == "math" and node.func.attr in _MATH_FUNCTIONS.keys() | {"pow", "prod", "lcm"}:
                    name = "math." + node.func.attr
            if not name:
                raise ValueError("Function is not allowed.")
            args = []
            for arg in node.args:
                if isinstance(arg, (ast.List, ast.Tuple)):
                    if len(arg.elts) > MAX_ARGUMENTS:
                        raise ValueError("Too many sequence values.")
                    args.append([_number(visit(item)) for item in arg.elts])
                else:
                    args.append(visit(arg))
            return _call(name, args)
        raise ValueError("Only arithmetic and approved math functions are allowed.")

    return _number(visit(tree.body))
