/**
 * High-performance, zero-builder protobuf wire codecs for @oh-my-pi/pi-catalog.
 *
 * Schemas are declared as static IR descriptors with near-zero module load overhead
 * and lazy compilation on first encode/decode/create invocation.
 */
/** JSON values carried by `google.protobuf.Value` fields. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** An unrecognised wire field retained for forward-compatible round-trips. */
export interface ProtoUnknownField {
    no: number;
    wireType: number;
    data: Uint8Array;
}
/** Shared internal metadata present on every decoded protocol message. */
export interface ProtoMessage {
    $typeName?: string;
    $unknown?: ProtoUnknownField[];
}
/** A bidirectional codec for one protobuf message type. */
export interface MessageCodec<T extends ProtoMessage = ProtoMessage> {
    (value: T): Uint8Array;
    (value: Uint8Array): T;
    /** Creates a message with protobuf defaults for omitted fields. */
    create(value?: Partial<T>): T;
    /** Encodes one message into protobuf wire bytes. */
    encode(value: T): Uint8Array;
    /** Decodes one protobuf message from wire bytes. */
    decode(value: Uint8Array): T;
    /** Converts a message to its protobuf JSON representation. */
    toJson(value: T): JsonValue;
}
/** Infers a message shape from a codec result. */
export type InferMessage<TCodec> = TCodec extends MessageCodec<infer TMessage> ? TMessage : never;
/** Erases a referenced message's concrete shape for static field descriptors. */
export interface MessageReference {
    encode(value: unknown): Uint8Array;
    decode(value: Uint8Array): ProtoMessage;
    toJson(value: unknown): JsonValue;
}
export type ScalarKind = "bool" | "bytes" | "double" | "enum" | "float" | "int32" | "int64" | "string" | "uint32" | "uint64";
export type WireType = 0 | 1 | 2 | 5;
export interface ScalarFieldDesc {
    readonly no: number;
    readonly name: string;
    readonly kind: ScalarKind;
    readonly optional?: boolean;
    readonly repeat?: boolean;
}
export interface MessageFieldDesc {
    readonly no: number;
    readonly name: string;
    readonly kind: "message";
    readonly T: () => MessageReference;
    readonly repeat?: boolean;
}
export interface EnumFieldDesc {
    readonly no: number;
    readonly name: string;
    readonly kind: "enum";
    readonly optional?: boolean;
    readonly repeat?: boolean;
}
export interface MapFieldDesc {
    readonly no: number;
    readonly name: string;
    readonly kind: "map";
    readonly K: "string";
    readonly V: ScalarKind | (() => MessageReference);
}
export type VariantDesc = {
    readonly no: number;
    readonly name: string;
    readonly kind: ScalarKind;
} | {
    readonly no: number;
    readonly name: string;
    readonly kind: "message";
    readonly T: () => MessageReference;
};
export interface OneofFieldDesc {
    readonly kind: "oneof";
    readonly name: string;
    readonly variants: readonly VariantDesc[];
}
export type FieldDesc = ScalarFieldDesc | MessageFieldDesc | EnumFieldDesc | MapFieldDesc | OneofFieldDesc;
/** Creates a high-performance, lazy protobuf message codec from an IR field descriptor list. */
export declare function pb<T extends ProtoMessage = ProtoMessage>(typeName: string, fields?: readonly FieldDesc[]): MessageCodec<T>;
/** Creates a message using its codec's protobuf defaults. */
export declare function create<TMessage extends ProtoMessage>(codec: MessageCodec<TMessage>, value?: Partial<TMessage>): TMessage;
/** Encodes a message using its codec. */
export declare function toBinary<TMessage extends ProtoMessage>(codec: MessageCodec<TMessage>, value: TMessage): Uint8Array;
/** Decodes wire bytes using a message codec. */
export declare function fromBinary<TMessage extends ProtoMessage>(codec: MessageCodec<TMessage>, value: Uint8Array): TMessage;
/** Converts a message to protobuf JSON using its codec. */
export declare function toJson<TMessage extends ProtoMessage>(codec: MessageCodec<TMessage>, value: TMessage): JsonValue;
/** Encodes a JSON value as `google.protobuf.Value`. */
export declare function encodeJsonValue(value: JsonValue): Uint8Array;
/** Decodes `google.protobuf.Value` wire bytes into a JSON value. */
export declare function decodeJsonValue(value: Uint8Array): JsonValue;
