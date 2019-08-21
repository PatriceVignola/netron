/* jshint esversion: 6 */
/* eslint "indent": [ "error", 4, { "SwitchCase": 1 } ] */

var dmlplan = dmlplan || {};
var base = base || require('./base');
var long = long || { Long: require('long') };
var marked = marked || require('marked');

const fs = require("fs");
const path = require('path');

dmlplan.ModelFactory = class {

    match(context) {
        return context.identifier.endsWith('dmlplan.json');
    }

    open(context) {
        var jsonFile = JSON.parse(context.text);

        return new Promise(function(resolve, reject) {
            try {
                var plan = new dmlplan.Plan(jsonFile, context._context._folder);
                resolve(plan);
            }
            catch (error) {
                var message = error && error.message ? error.message : error.toString();
                message = message.endsWith('.') ? message.substring(0, message.length - 1) : message;
                reject(new dmlplan.Error(message + " in '" + context.identifier + "'."));
            }
        });
    }
};

dmlplan.Plan = class {
    constructor(plan, folder) {
        this._graphs = [];
        this._metadata = [];

        if (plan) {
            var graph = new dmlplan.Graph(plan, folder);
            this._graphs.push(graph);
        }

        // TODO (pavignol): Here add versioning information (e.g. producer, domain, version)
    }

    get format() {
        return 'dmlplan';
    }

    get metadata() {
        return this._metadata;
    }

    get graphs() {
        return this._graphs;
    }
};

dmlplan.Graph = class {
    constructor(plan, folder) {
        this._name = '';
        this._description = '';
        this._inputs = [];
        this._outputs = [];
        this._nodes = [];
        this._initializers = [];

        var previousBarrierOutputEdges = [];
        var nextBarrierInputEdges = [];

        var previousBarrierNode = null;

        const inputBuffers = [];

        plan.Inputs.forEach((input, index) => {
            const name = 'input_' + index;
            const param = new dmlplan.Parameter(name);
            const initializer = input.Data ? new dmlplan.Tensor(input, folder) : null;

            param.addArgument(new dmlplan.Argument(name, 'float32[1,3,256,256]', initializer));

            // Only non-weights have their own nodes; weights are embedded inside operator nodes
            if (!initializer) {
                this._inputs.push(param);
            }

            inputBuffers.push(param);
        });

        plan.Outputs.forEach((output, index) => {
            const name = 'output_' + index;
            const param = new dmlplan.Parameter(name);
            param.addArgument(new dmlplan.Argument(name, 'float32[1,3,256,256]'));
            this._outputs.push(param);
        });

        plan.Steps.forEach((step, index) => {
            if (step.StepType === 'ExecuteDmlOperation') {
                const node = new dmlplan.OperatorNode(step.OperatorType.EnumName, [], [], []);

                const nodeInputs = [];
                const nodeOutputs = [];

                if (previousBarrierNode) {
                    const inputEdgeName = 'input_edge_' + index;
                    const inputEdge = new dmlplan.Parameter(inputEdgeName);
                    inputEdge.addArgument(new dmlplan.Argument(inputEdgeName, 'float32[1,3,256,256]'));
                    nodeInputs.push(inputEdge);

                    previousBarrierOutputEdges.push(inputEdge);
                }

                Object.keys(step.Inputs).forEach(key => {
                    const input = step.Inputs[key];

                    if (input.BufferKind === 'Input') {
                        nodeInputs.push(inputBuffers[input.BufferIndex]);
                    }
                });

                node.inputs = nodeInputs;

                Object.keys(step.Outputs).forEach(key => {
                    const output = step.Outputs[key];

                    if (output.BufferKind === 'Output') {
                        nodeOutputs.push(this._outputs[output.BufferIndex]);
                    }
                });

                const outputEdgeName = 'output_edge_' + index;
                const outputEdge = new dmlplan.Parameter(outputEdgeName);
                outputEdge.addArgument(new dmlplan.Argument(outputEdgeName, 'float32[1,3,256,256]'));
                nodeOutputs.push(outputEdge);

                node.outputs = nodeOutputs;

                const attributes = [];

                Object.keys(step.Attributes).forEach(key => {
                    attributes.push(new dmlplan.Attribute(key, step.Attributes[key]));
                });

                node.attributes = attributes;

                nextBarrierInputEdges.push(outputEdge);

                this._nodes.push(node);
            } else if (step.StepType === 'GlobalUAVBarrier') {
                if (previousBarrierNode) {
                    previousBarrierNode.outputs = previousBarrierOutputEdges;
                    previousBarrierOutputEdges = [];
                }

                const newBarrierNode = new dmlplan.BarrierNode();
                newBarrierNode.inputs = nextBarrierInputEdges;
                nextBarrierInputEdges = [];
                this._nodes.push(newBarrierNode);

                previousBarrierNode = newBarrierNode;
            } else {
                throw new dmlplan.Error('Unsupported step type "' + step.StepType + ".");
            }
        });

        if (previousBarrierNode) {
            previousBarrierNode.outputs = previousBarrierOutputEdges;
        }
    }

    get name() {
        return this._name;
    }

    get description() {
        return this._description;
    }

    get groups() {
        return false;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }
};

dmlplan.Parameter = class {
    constructor(name) {
        this._name = name;
        this._arguments = [];
    }

    addArgument(arg) {
        this._arguments.push(arg);
    }

    get name() {
        return this._name;
    }

    get visible() {
        return true;
    }

    get arguments() {
        return this._arguments;
    }
};

dmlplan.Attribute = class {
    constructor(name, value) {
        this._name = name;
        this._value = value;
        this._type = 'type';
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get value() {
        return this._value;
    }

    get description() {
        return this._description;
    }

    get visible() {
        return true;
    }
};

dmlplan.Argument = class {
    constructor(id, type, description, initializer) {
        this._id = id;
        this._type = type || null;
        this._description = description || '';
        this._initializer = initializer || null;
    }

    get id() {
        return this._id;
    }

    get type() {
        if (this._type) {
            return this._type;
        }
        if (this._initializer) {
            return this._initializer.type;
        }
        return null;
    }

    get description() {
        return this._description;
    }

    get initializer() {
        return this._initializer;
    }
};

dmlplan.Tensor = class {
    constructor(tensor, basePath) {
        this._tensor = tensor;
        this._name = tensor.name || '';
        this._type = new dmlplan.TensorType(tensor.DataType, new dmlplan.TensorShape(tensor.Dimensions || []), tensor.Denotation);

        if (!tensor.BufferSize)
        {
            throw new dmlplan.Error('Field "BufferSize" not found.');
        }

        if (tensor.Data)
        {
            this._tensor.raw_data = fs.readFileSync(path.join(basePath, tensor.Data)).buffer;
        }
    }

    get name() {
        return this._name;
    }

    get kind() {
        return this._kind;
    }

    get type() {
        return this._type;
    }

    toString() {
        return 'DmlPlan Tensor';
    }
};

dmlplan.OperatorNode = class {
    constructor(operator, attributes, inputs, outputs) {
        this._operator = operator;
        this._name = operator;
        this._attributes = attributes;
        this._inputs = inputs;
        this._outputs = outputs;
    }

    set inputs(nodes) {
        this._inputs = nodes;
    }

    set outputs(nodes) {
        this._outputs = nodes;
    }

    set attributes(attributes) {
        this._attributes = attributes;
    }

    get operator() {
        return this._operator;
    }

    get name() {
        return this._name;
    }

    get attributes() {
        return this._attributes;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }
};

dmlplan.BarrierNode = class {
    constructor() {
        this._name = 'Global UAV Barrier'
        this._inputs = [];
        this._outputs = [];
    }

    set inputs(nodes) {
        this._inputs = nodes;
    }

    set outputs(nodes) {
        this._outputs = nodes;
    }

    get operator() {
        return this._name;
    }

    get name() {
        return this._name;
    }

    get attributes() {
        return [];
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }
};

dmlplan.TensorType = class {

    constructor(dataType, shape, denotation) {
        this._dataType = dataType || 'bytes';
        this._shape = shape || [];
        this._denotation = denotation || null;
    }

    get dataType() {
        return this._dataType;
    }

    get shape() {
        return this._shape;
    }

    get denotation() { 
        return this._denotation;
    }

    toString() {
        return this.dataType + this._shape.toString();
    }
};

dmlplan.TensorShape = class {
    constructor(dimensions) {
        this._dimensions = dimensions;
    }

    get dimensions() {
        return this._dimensions;
    }

    toString() {
        if (!this._dimensions || this._dimensions.length == 0) {
            return '';
        }
        return '[' + this._dimensions.join(',') + ']';
    }
};

dmlplan.Error = class extends Error {
    constructor(message) {
        super(message);
        this.name = 'Error loading DirectML plan.';
    }
};

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports.ModelFactory = dmlplan.ModelFactory;
}
