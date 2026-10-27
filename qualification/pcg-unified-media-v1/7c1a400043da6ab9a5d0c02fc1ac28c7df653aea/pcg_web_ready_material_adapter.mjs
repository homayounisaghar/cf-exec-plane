import { MediaAcquisitionError } from "./pcg_unified_media_acquisition.mjs";

/**
 * Zero-copy adapter for files already ingested with the existing authenticated
 * CF-server -> PCG private material transfer. It does not resolve URLs,
 * open provider sessions, or duplicate source bytes. The ASR/material consumer
 * independently verifies SHA-256 and exact size before processing.
 */
export function createReadyMaterialAdapter() {
  return {
    async adopt({ source_ref, owner_context, authorization_context }) {
      if (!owner_context || authorization_context?.verified_upload !== true)
        throw new MediaAcquisitionError("MEDIA_AUTH_CONTEXT_REQUIRED");
      const handle = source_ref?.handle;
      if (!/^pcgfile:[0-9a-f]{64}$/.test(handle || ""))
        throw new MediaAcquisitionError("MEDIA_MATERIAL_HANDLE_INVALID");
      if (!Number.isSafeInteger(source_ref?.size_bytes) || source_ref.size_bytes < 1)
        throw new MediaAcquisitionError("MEDIA_SOURCE_SIZE_OUT_OF_BOUNDS");
      if (!/^[0-9a-f]{64}$/.test(source_ref?.sha256_hex || ""))
        throw new MediaAcquisitionError("MEDIA_SOURCE_DIGEST_INVALID");
      return {
        material_file_handle:handle,
        filename:source_ref.filename,
        media_type:source_ref.media_type,
        size_bytes:source_ref.size_bytes,
        sha256_hex:source_ref.sha256_hex,
        source_provenance:{ref_kind:"owner_upload_ticket"},
      };
    },
  };
}
