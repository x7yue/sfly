import { loadVersionedFiles, type VersionedFile } from "./versioned-files.js";

export type ClientTarball = VersionedFile;

const TARBALL = /^sfly-client-([0-9][^-]*)\.tgz$/;

export const loadClientTarballs = (dir: string | undefined) => loadVersionedFiles(dir, TARBALL);

export const clientTarballUrl = (publicHttpUrl: string, tarball: ClientTarball) =>
	`${publicHttpUrl}/client/${encodeURIComponent(tarball.version)}/${encodeURIComponent(tarball.filename)}`;
