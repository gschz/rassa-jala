import { TRPCClientError } from "@trpc/client";
import { describe, expect, test } from "bun:test";

import { esErrorDeRed, mensajeDeError } from "./notificar-error";

// httpBatchLink wraps every fetch rejection in TRPCClientError (original error
// rides as .cause) — the network branch must survive that wrapping.
describe("notificar-error", () => {
  test("detecta fallos de transporte directos (Chrome/Firefox/Safari/undici)", () => {
    expect(esErrorDeRed(new TypeError("Failed to fetch"))).toBe(true);
    expect(esErrorDeRed(new TypeError("NetworkError when attempting to fetch resource."))).toBe(
      true,
    );
    expect(esErrorDeRed(new TypeError("Load failed"))).toBe(true);
    expect(esErrorDeRed(new TypeError("fetch failed"))).toBe(true);
    expect(esErrorDeRed(new Error("ECONNREFUSED: Unable to connect to 127.0.0.1:3000"))).toBe(true);
  });

  test("detecta el TypeError envuelto por tRPC (cadena de cause)", () => {
    const envuelto = TRPCClientError.from(new TypeError("Failed to fetch"));
    expect(esErrorDeRed(envuelto)).toBe(true);
    expect(mensajeDeError(envuelto)).toContain("Sin conexión con el servidor");
  });

  test("los errores de negocio del servidor conservan su mensaje", () => {
    const negocio = new Error("El correo ya está registrado");
    expect(esErrorDeRed(negocio)).toBe(false);
    expect(mensajeDeError(negocio)).toBe("El correo ya está registrado");
  });

  test("valores no-Error no se tratan como red", () => {
    expect(esErrorDeRed("fetch failed")).toBe(false);
    expect(esErrorDeRed(undefined)).toBe(false);
    expect(mensajeDeError(undefined)).toBe("Ocurrió un error inesperado.");
  });
});
