"use strict";

import { Set, List, Map, OrderedSet, Iterable } from "immutable";
import {
    TopLevels,
    Type,
    PrimitiveType,
    ArrayType,
    MapType,
    UnionType,
    NamedType,
    ClassType,
    nullableFromUnion,
    removeNullFromUnion,
    allClassesAndUnions
} from "../Type";
import { Source, Sourcelike, newline, annotated } from "../Source";
import {
    legalizeCharacters,
    camelCase,
    startWithLetter,
    stringEscape,
    intercalate
} from "../Support";
import {
    Namespace,
    Name,
    SimpleName,
    FixedName,
    Namer,
    keywordNamespace,
    PrefixNamer
} from "../Naming";
import { PrimitiveTypeKind, TypeKind } from "Reykjavik";
import { Renderer, RenderResult } from "../Renderer";
import { TypeScriptTargetLanguage } from "../TargetLanguage";
import { BooleanOption, StringOption, EnumOption } from "../RendererOptions";
import { IssueAnnotation } from "../Annotation";

const unicode = require("unicode-properties");

type Version = 5 | 6;
type Features = { helpers: boolean; attributes: boolean };

export default class CSharpTargetLanguage extends TypeScriptTargetLanguage {
    private readonly _listOption: EnumOption<boolean>;
    private readonly _denseOption: EnumOption<boolean>;
    private readonly _featuresOption: EnumOption<Features>;
    private readonly _namespaceOption: StringOption;
    private readonly _versionOption: EnumOption<Version>;

    constructor() {
        const listOption = new EnumOption("array-type", "Use T[] or List<T>", [
            ["array", false],
            ["list", true]
        ]);
        const denseOption = new EnumOption("density", "Property density", [
            ["normal", false],
            ["dense", true]
        ]);
        const featuresOption = new EnumOption("features", "Output features", [
            ["complete", { helpers: true, attributes: true }],
            ["attributes-only", { helpers: false, attributes: true }],
            ["just-types", { helpers: false, attributes: false }]
        ]);
        // FIXME: Do this via a configurable named eventually.
        const namespaceOption = new StringOption(
            "namespace",
            "Generated namespace",
            "NAME",
            "QuickType"
        );
        const versionOption = new EnumOption<Version>("csharp-version", "C# version", [
            ["6", 6],
            ["5", 5]
        ]);
        const options = [namespaceOption, versionOption, denseOption, listOption, featuresOption];
        super("C#", ["cs", "csharp"], "cs", options.map(o => o.definition));
        this._listOption = listOption;
        this._denseOption = denseOption;
        this._featuresOption = featuresOption;
        this._namespaceOption = namespaceOption;
        this._versionOption = versionOption;
    }

    renderGraph(topLevels: TopLevels, optionValues: { [name: string]: any }): RenderResult {
        const { helpers, attributes } = this._featuresOption.getValue(optionValues);
        const renderer = new CSharpRenderer(
            topLevels,
            this._listOption.getValue(optionValues),
            this._denseOption.getValue(optionValues),
            helpers,
            attributes,
            this._namespaceOption.getValue(optionValues),
            this._versionOption.getValue(optionValues)
        );
        return renderer.render();
    }
}

const forbiddenNames = ["QuickType", "Converter", "JsonConverter", "Type", "Serialize"];

export const namingFunction = new PrefixNamer([
    "Purple",
    "Fluffy",
    "Tentacled",
    "Sticky",
    "Indigo",
    "Indecent",
    "Hilarious",
    "Ambitious",
    "Cunning",
    "Magenta",
    "Frisky",
    "Mischievous",
    "Braggadocious"
]);

// FIXME: Make a Named?
const denseJsonPropertyName = "J";

function proposeTopLevelDependencyName(names: List<string>): string {
    if (names.size !== 1) throw "Cannot deal with more than one dependency";
    return names.first();
}

function isStartCharacter(c: string): boolean {
    const code = c.charCodeAt(0);
    if (unicode.isAlphabetic(code)) {
        return true;
    }
    return c == "_";
}

function isPartCharacter(c: string): boolean {
    const category: string = unicode.getCategory(c.charCodeAt(0));
    if (["Nd", "Pc", "Mn", "Mc"].indexOf(category) >= 0) {
        return true;
    }
    return isStartCharacter(c);
}

const legalizeName = legalizeCharacters(isPartCharacter);

function csNameStyle(original: string): string {
    const legalized = legalizeName(original);
    const cameled = camelCase(legalized);
    return startWithLetter(isStartCharacter, true, cameled);
}

function isValueType(t: Type): boolean {
    if (t instanceof PrimitiveType) {
        return ["integer", "double", "bool"].indexOf(t.kind) >= 0;
    }
    return false;
}

class CSharpRenderer extends Renderer {
    private _globalNamespace: Namespace;
    private _topLevelNames: Map<string, Name>;
    private _classAndUnionNames: Map<NamedType, Name>;
    private _propertyNames: Map<ClassType, Map<string, Name>>;

    constructor(
        topLevels: TopLevels,
        private readonly _useList: boolean,
        private readonly _dense: boolean,
        private readonly _needHelpers: boolean,
        private readonly _needAttributes: boolean,
        private readonly _namespaceName: string,
        private readonly _version: Version
    ) {
        super(topLevels);
    }

    protected setUpNaming(): Namespace[] {
        this._globalNamespace = keywordNamespace("global", forbiddenNames);
        const { classes, unions } = allClassesAndUnions(this.topLevels);
        const namedUnions = unions.filter((u: UnionType) => !nullableFromUnion(u)).toSet();
        this._classAndUnionNames = Map();
        this._propertyNames = Map();
        this._topLevelNames = this.topLevels.map(this.namedFromTopLevel).toMap();
        classes.forEach((c: ClassType) => {
            const named = this.addClassOrUnionNamed(c);
            this.addPropertyNameds(c, named);
        });
        namedUnions.forEach((u: UnionType) => this.addClassOrUnionNamed(u));
        return [this._globalNamespace];
    }

    namedFromTopLevel = (type: Type, name: string): FixedName => {
        // FIXME: leave the name as-is?
        const proposed = csNameStyle(name);
        const named = new FixedName(this._globalNamespace, proposed);

        const definedTypes = type.directlyReachableNamedTypes;
        if (definedTypes.size > 1) {
            throw "Cannot have more than one defined type per top-level";
        }

        // If the top-level type doesn't contain any classes or unions
        // we have to define a class just for the `FromJson` method, in
        // emitFromJsonForTopLevel.

        if (definedTypes.size === 1) {
            const definedType = definedTypes.first();
            this._classAndUnionNames = this._classAndUnionNames.set(definedType, named);
        }

        return named;
    };

    addClassOrUnionNamed = (type: NamedType): Name => {
        if (this._classAndUnionNames.has(type)) {
            return this._classAndUnionNames.get(type);
        }
        const name = type.names.combined;
        const named = new SimpleName(
            this._globalNamespace,
            name,
            csNameStyle(name),
            namingFunction
        );
        this._classAndUnionNames = this._classAndUnionNames.set(type, named);
        return named;
    };

    addPropertyNameds = (c: ClassType, classNamed: Name): void => {
        const ns = new Namespace(c.names.combined, this._globalNamespace, Set(), Set([classNamed]));
        const names = c.properties
            .map((t: Type, name: string) => {
                return new SimpleName(ns, name, csNameStyle(name), namingFunction);
            })
            .toMap();
        this._propertyNames = this._propertyNames.set(c, names);
    };

    emitBlock = (f: () => void, semicolon: boolean = false): void => {
        this.emitLine("{");
        this.indent(f);
        this.emitLine("}", semicolon ? ";" : "");
    };

    csType = (t: Type): Sourcelike => {
        if (t instanceof PrimitiveType) {
            switch (t.kind) {
                case "any":
                    return annotated(
                        new IssueAnnotation(
                            "quicktype cannot infer this type because there is no data about in the input."
                        ),
                        "object"
                    );
                case "null":
                    return annotated(
                        new IssueAnnotation(
                            "The only value for this in the input is null, which means you probably need a more complete input sample."
                        ),
                        "object"
                    );
                case "bool":
                    return "bool";
                case "integer":
                    return "long";
                case "double":
                    return "double";
                case "string":
                    return "string";
            }
        } else if (t instanceof ArrayType) {
            const itemsType = this.csType(t.items);
            if (this._useList) {
                return ["List<", itemsType, ">"];
            } else {
                return [itemsType, "[]"];
            }
        } else if (t instanceof ClassType) {
            return this._classAndUnionNames.get(t);
        } else if (t instanceof MapType) {
            return ["Dictionary<string, ", this.csType(t.values), ">"];
        } else if (t instanceof UnionType) {
            const nonNull = nullableFromUnion(t);
            if (nonNull) return this.nullableCSType(nonNull);
            return this._classAndUnionNames.get(t);
        }
        throw "Unknown type";
    };

    typeNameForUnionMember = (t: Type): string => {
        if (t instanceof PrimitiveType) {
            switch (t.kind) {
                case "any":
                    return "anything";
                case "null":
                    return "null";
                case "bool":
                    return "bool";
                case "integer":
                    return "long";
                case "double":
                    return "double";
                case "string":
                    return "string";
            }
        } else if (t instanceof ArrayType) {
            return this.typeNameForUnionMember(t.items) + "_array";
        } else if (t instanceof ClassType) {
            return this.names.get(this._classAndUnionNames.get(t));
        } else if (t instanceof MapType) {
            return this.typeNameForUnionMember(t.values), "_map";
        } else if (t instanceof UnionType) {
            return "union";
        }
        throw "Unknown type";
    };

    nullableCSType = (t: Type): Sourcelike => {
        const csType = this.csType(t);
        if (isValueType(t)) {
            return [csType, "?"];
        } else {
            return csType;
        }
    };

    emitClass = (declaration: Sourcelike, name: Sourcelike, emitter: () => void): void => {
        this.emitLine("public ", declaration, " ", name);
        this.emitBlock(emitter);
    };

    get partialString(): string {
        return this._needHelpers ? "partial " : "";
    }

    emitClassDefinition = (c: ClassType): void => {
        const jsonProperty = this._dense ? denseJsonPropertyName : "JsonProperty";
        const propertyNames = this._propertyNames.get(c);
        this.emitClass([this.partialString, "class"], this._classAndUnionNames.get(c), () => {
            const maxWidth = c.properties.map((_, name: string) => stringEscape(name).length).max();
            const withBlankLines = this._needAttributes && !this._dense;
            this.forEach(c.properties, withBlankLines, false, (t: Type, name: string) => {
                const named = propertyNames.get(name);
                const escapedName = stringEscape(name);
                const attribute = ["[", jsonProperty, '("', escapedName, '")]'];
                const property = ["public ", this.csType(t), " ", named, " { get; set; }"];
                if (!this._needAttributes) {
                    this.emitLine(property);
                } else if (this._dense) {
                    const indent = maxWidth - escapedName.length + 1;
                    const whitespace = " ".repeat(indent);
                    this.emitLine(attribute, whitespace, property);
                } else {
                    this.emitLine(attribute);
                    this.emitLine(property);
                }
            });
        });
    };

    unionFieldName = (t: Type): string => {
        return csNameStyle(this.typeNameForUnionMember(t));
    };

    emitUnionDefinition = (c: UnionType): void => {
        const [_, nonNulls] = removeNullFromUnion(c);
        this.emitClass([this.partialString, "struct"], this._classAndUnionNames.get(c), () => {
            nonNulls.forEach((t: Type) => {
                const csType = this.nullableCSType(t);
                const field = this.unionFieldName(t);
                this.emitLine("public ", csType, " ", field, ";");
            });
        });
    };

    emitExpressionMember(declare: Sourcelike, define: Sourcelike): void {
        if (this._version === 5) {
            this.emitLine(declare);
            this.emitBlock(() => {
                this.emitLine("return ", define, ";");
            });
        } else {
            this.emitLine(declare, " => ", define, ";");
        }
    }

    emitFromJsonForTopLevel = (t: Type, name: string): void => {
        let partial: string;
        let typeKind: string;
        const definedTypes = t.directlyReachableNamedTypes;
        if (definedTypes.isEmpty()) {
            partial = "";
            typeKind = "class";
        } else {
            partial = "partial ";
            typeKind = definedTypes.first() instanceof ClassType ? "class" : "struct";
        }
        const csType = this.csType(t);
        this.emitClass([partial, typeKind], this._topLevelNames.get(name), () => {
            // FIXME: Make FromJson a Named
            this.emitExpressionMember(
                ["public static ", csType, " FromJson(string json)"],
                ["JsonConvert.DeserializeObject<", csType, ">(json, Converter.Settings)"]
            );
        });
    };

    emitUnionJSONPartial = (u: UnionType): void => {
        const tokenCase = (tokenType: string): void => {
            this.emitLine("case JsonToken.", tokenType, ":");
        };

        const emitNullDeserializer = (): void => {
            tokenCase("Null");
            this.indent(() => this.emitLine("break;"));
        };

        const emitDeserializeType = (t: Type): void => {
            this.emitLine(
                this.unionFieldName(t),
                " = serializer.Deserialize<",
                this.csType(t),
                ">(reader);"
            );
            this.emitLine("break;");
        };

        const emitPrimitiveDeserializer = (tokenTypes: string[], kind: PrimitiveTypeKind): void => {
            const t = u.findMember(kind);
            if (!t) return;

            for (const tokenType of tokenTypes) {
                tokenCase(tokenType);
            }
            this.indent(() => emitDeserializeType(t));
        };

        const emitDoubleSerializer = (): void => {
            const t = u.findMember("double");
            if (!t) return;

            if (!u.findMember("integer")) tokenCase("Integer");
            tokenCase("Float");
            this.indent(() => emitDeserializeType(t));
        };

        const emitGenericDeserializer = (kind: TypeKind, tokenType: string): void => {
            const t = u.findMember(kind);
            if (!t) return;

            tokenCase(tokenType);
            this.indent(() => emitDeserializeType(t));
        };

        const [hasNull, nonNulls] = removeNullFromUnion(u);
        const named = this._classAndUnionNames.get(u);
        this.emitClass("partial struct", named, () => {
            this.emitLine("public ", named, "(JsonReader reader, JsonSerializer serializer)");
            this.emitBlock(() => {
                nonNulls.forEach((t: Type) => {
                    this.emitLine(this.unionFieldName(t), " = null;");
                });
                this.emitNewline();
                this.emitLine("switch (reader.TokenType)");
                this.emitBlock(() => {
                    if (hasNull) emitNullDeserializer();
                    emitPrimitiveDeserializer(["Integer"], "integer");
                    emitDoubleSerializer();
                    emitPrimitiveDeserializer(["Boolean"], "bool");
                    emitPrimitiveDeserializer(["String", "Date"], "string");
                    emitGenericDeserializer("array", "StartArray");
                    emitGenericDeserializer("class", "StartObject");
                    emitGenericDeserializer("map", "StartObject");
                    this.emitLine('default: throw new Exception("Cannot convert ', named, '");');
                });
            });
            this.emitNewline();
            this.emitLine("public void WriteJson(JsonWriter writer, JsonSerializer serializer)");
            this.emitBlock(() => {
                nonNulls.forEach((t: Type) => {
                    const fieldName = this.unionFieldName(t);
                    this.emitLine("if (", fieldName, " != null)");
                    this.emitBlock(() => {
                        this.emitLine("serializer.Serialize(writer, ", fieldName, ");");
                        this.emitLine("return;");
                    });
                });
                if (hasNull) {
                    this.emitLine("writer.WriteNull();");
                } else {
                    this.emitLine('throw new Exception("Union must not be null");');
                }
            });
        });
    };

    emitSerializeClass = (): void => {
        // FIXME: Make Serialize a Named
        this.emitClass("static class", "Serialize", () => {
            this.topLevels.forEach((t: Type, name: string) => {
                // FIXME: Make ToJson a Named
                this.emitExpressionMember(
                    ["public static string ToJson(this ", this.csType(t), " self)"],
                    "JsonConvert.SerializeObject(self, Converter.Settings)"
                );
            });
        });
    };

    emitUnionConverterMembers = (unions: Iterable<any, UnionType>): void => {
        const names = unions.map((u: UnionType) => this._classAndUnionNames.get(u)).toOrderedSet();
        const canConvertExpr = intercalate(
            " || ",
            names.map((n: Name): Sourcelike => ["t == typeof(", n, ")"])
        );
        // FIXME: make Iterable<any, Sourcelike> a Sourcelike, too?
        this.emitExpressionMember(
            "public override bool CanConvert(Type t)",
            canConvertExpr.toArray()
        );
        this.emitNewline();
        this.emitLine(
            "public override object ReadJson(JsonReader reader, Type t, object existingValue, JsonSerializer serializer)"
        );
        this.emitBlock(() => {
            // FIXME: call the constructor via reflection?
            names.forEach((n: Name) => {
                this.emitLine("if (t == typeof(", n, "))");
                this.indent(() => this.emitLine("return new ", n, "(reader, serializer);"));
            });
            this.emitLine('throw new Exception("Unknown type");');
        });
        this.emitNewline();
        this.emitLine(
            "public override void WriteJson(JsonWriter writer, object value, JsonSerializer serializer)"
        );
        this.emitBlock(() => {
            this.emitLine("var t = value.GetType();");
            names.forEach((n: Name) => {
                this.emitLine("if (t == typeof(", n, "))");
                this.emitBlock(() => {
                    this.emitLine("((", n, ")value).WriteJson(writer, serializer);");
                    this.emitLine("return;");
                });
            });
            this.emitLine('throw new Exception("Unknown type");');
        });
    };

    emitConverterClass = (unions: Iterable<any, UnionType>): void => {
        const haveUnions = !unions.isEmpty();
        // FIXME: Make Converter a Named
        let converterName: Sourcelike = ["Converter"];
        if (haveUnions) converterName = converterName.concat([": JsonConverter"]);
        this.emitClass("class", converterName, () => {
            if (haveUnions) {
                this.emitUnionConverterMembers(unions);
                this.emitNewline();
            }
            this.emitLine(
                "public static readonly JsonSerializerSettings Settings = new JsonSerializerSettings"
            );
            this.emitBlock(() => {
                this.emitLine("MetadataPropertyHandling = MetadataPropertyHandling.Ignore,");
                this.emitLine("DateParseHandling = DateParseHandling.None,");
                if (haveUnions) {
                    this.emitLine("Converters = { new Converter() },");
                }
            }, true);
        });
    };

    childrenOfType = (t: Type): OrderedSet<Type> => {
        const names = this.names;
        if (t instanceof ClassType) {
            const propertyNameds = this._propertyNames.get(t);
            return t.properties
                .sortBy((_, n: string): string => names.get(propertyNameds.get(n)))
                .toOrderedSet();
        }
        return t.children.toOrderedSet();
    };

    protected emitSource(): void {
        const { classes, unions } = allClassesAndUnions(this.topLevels, this.childrenOfType);
        const namedUnions = unions.filter((u: UnionType) => !nullableFromUnion(u)).toOrderedSet();

        const using = (ns: Sourcelike): void => {
            this.emitLine("using ", ns, ";");
        };

        this.emitLine("namespace ", this._namespaceName);
        this.emitBlock(() => {
            for (const ns of ["System", "System.Net", "System.Collections.Generic"]) {
                using(ns);
            }
            if (this._needAttributes || this._needHelpers) {
                this.emitNewline();
                using("Newtonsoft.Json");
                if (this._dense) {
                    using([denseJsonPropertyName, " = Newtonsoft.Json.JsonPropertyAttribute"]);
                }
            }
            this.forEachWithLeadingAndInterposedBlankLines(classes, this.emitClassDefinition);
            this.forEachWithLeadingAndInterposedBlankLines(namedUnions, this.emitUnionDefinition);
            if (this._needHelpers) {
                this.emitNewline();
                this.topLevels.forEach(this.emitFromJsonForTopLevel);
                this.forEachWithLeadingAndInterposedBlankLines(
                    namedUnions,
                    this.emitUnionJSONPartial
                );
                this.emitNewline();
                this.emitSerializeClass();
            }
            if (this._needHelpers || (this._needAttributes && !namedUnions.isEmpty())) {
                this.emitNewline();
                this.emitConverterClass(namedUnions);
            }
        });
    }
}
