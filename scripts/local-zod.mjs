function cloneDefaultValue(value) {
  if (value !== null && typeof value === "object") {
    return structuredClone(value);
  }

  return value;
}

function describeReceived(input) {
  if (input === null) {
    return "null";
  }

  if (input === undefined) {
    return "undefined";
  }

  if (Array.isArray(input)) {
    return "array";
  }

  return typeof input;
}

class BaseSchema {
  safeParse(input) {
    try {
      return {
        success: true,
        data: this.parse(input)
      };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [
            {
              path: [],
              message: error instanceof Error ? error.message : String(error)
            }
          ]
        }
      };
    }
  }

  optional() {
    const inner = this;
    return new WrappedSchema((input) => (
      input === undefined ? undefined : inner.parse(input)
    ));
  }

  nullable() {
    const inner = this;
    return new WrappedSchema((input) => (
      input === null ? null : inner.parse(input)
    ));
  }

  default(defaultValue) {
    const inner = this;
    return new WrappedSchema((input) => (
      input === undefined ? cloneDefaultValue(defaultValue) : inner.parse(input)
    ));
  }
}

class WrappedSchema extends BaseSchema {
  constructor(parser) {
    super();
    this.parser = parser;
  }

  parse(input) {
    const parser = this.parser;
    return parser(input);
  }
}

class StringSchema extends BaseSchema {
  constructor(checks = []) {
    super();
    this.checks = checks;
  }

  min(length) {
    return new StringSchema([
      ...this.checks,
      (value) => {
        if (value.length < length) {
          throw new Error(`Expected string length >= ${length}`);
        }
      }
    ]);
  }

  datetime() {
    return new StringSchema([
      ...this.checks,
      (value) => {
        if (Number.isNaN(Date.parse(value))) {
          throw new Error("Expected ISO datetime string");
        }
      }
    ]);
  }

  parse(input) {
    if (typeof input !== "string") {
      throw new Error(`Expected string, received ${describeReceived(input)}`);
    }

    for (const check of this.checks) {
      check(input);
    }

    return input;
  }
}

class NumberSchema extends BaseSchema {
  constructor(options = {}) {
    super();
    this.options = {
      integer: false,
      min: null,
      max: null,
      ...options
    };
  }

  int() {
    return new NumberSchema({
      ...this.options,
      integer: true
    });
  }

  min(value) {
    return new NumberSchema({
      ...this.options,
      min: this.options.min === null ? value : Math.max(this.options.min, value)
    });
  }

  max(value) {
    return new NumberSchema({
      ...this.options,
      max: this.options.max === null ? value : Math.min(this.options.max, value)
    });
  }

  positive() {
    return this.min(Number.EPSILON);
  }

  nonnegative() {
    return this.min(0);
  }

  parse(input) {
    if (typeof input !== "number" || Number.isNaN(input)) {
      throw new Error(`Expected number, received ${describeReceived(input)}`);
    }

    if (this.options.integer && !Number.isInteger(input)) {
      throw new Error("Expected integer");
    }

    if (this.options.min !== null && input < this.options.min) {
      throw new Error(`Expected number >= ${this.options.min}`);
    }

    if (this.options.max !== null && input > this.options.max) {
      throw new Error(`Expected number <= ${this.options.max}`);
    }

    return input;
  }
}

class BooleanSchema extends BaseSchema {
  parse(input) {
    if (typeof input !== "boolean") {
      throw new Error(`Expected boolean, received ${describeReceived(input)}`);
    }

    return input;
  }
}

class UnknownSchema extends BaseSchema {
  parse(input) {
    return input;
  }
}

class EnumSchema extends BaseSchema {
  constructor(values) {
    super();
    this.values = [...values];
    this.allowed = new Set(this.values);
  }

  parse(input) {
    if (!this.allowed.has(input)) {
      throw new Error(`Expected one of ${this.values.join(", ")}`);
    }

    return input;
  }
}

class LiteralSchema extends BaseSchema {
  constructor(value) {
    super();
    this.value = value;
  }

  parse(input) {
    if (input !== this.value) {
      throw new Error(`Expected literal ${String(this.value)}`);
    }

    return input;
  }
}

class ArraySchema extends BaseSchema {
  constructor(itemSchema, minLength = null) {
    super();
    this.itemSchema = itemSchema;
    this.minLength = minLength;
  }

  min(length) {
    return new ArraySchema(this.itemSchema, length);
  }

  parse(input) {
    if (!Array.isArray(input)) {
      throw new Error(`Expected array, received ${describeReceived(input)}`);
    }

    if (this.minLength !== null && input.length < this.minLength) {
      throw new Error(`Expected array length >= ${this.minLength}`);
    }

    return input.map((item) => this.itemSchema.parse(item));
  }
}

class RecordSchema extends BaseSchema {
  constructor(valueSchema) {
    super();
    this.valueSchema = valueSchema;
  }

  parse(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`Expected object, received ${describeReceived(input)}`);
    }

    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        this.valueSchema.parse(value)
      ])
    );
  }
}

class ObjectSchema extends BaseSchema {
  constructor(shape) {
    super();
    this.shape = { ...shape };
  }

  omit(keys) {
    const nextShape = { ...this.shape };
    for (const key of Object.keys(keys)) {
      delete nextShape[key];
    }
    return new ObjectSchema(nextShape);
  }

  extend(shape) {
    return new ObjectSchema({
      ...this.shape,
      ...shape
    });
  }

  parse(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`Expected object, received ${describeReceived(input)}`);
    }

    const output = {
      ...input
    };

    for (const [key, schema] of Object.entries(this.shape)) {
      output[key] = schema.parse(input[key]);
    }

    return output;
  }
}

export const z = {
  string() {
    return new StringSchema();
  },
  number() {
    return new NumberSchema();
  },
  boolean() {
    return new BooleanSchema();
  },
  unknown() {
    return new UnknownSchema();
  },
  enum(values) {
    return new EnumSchema(values);
  },
  literal(value) {
    return new LiteralSchema(value);
  },
  array(itemSchema) {
    return new ArraySchema(itemSchema);
  },
  record(valueSchema) {
    return new RecordSchema(valueSchema);
  },
  object(shape) {
    return new ObjectSchema(shape);
  }
};

export default z;
