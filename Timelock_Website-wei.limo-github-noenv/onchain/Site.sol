// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct KeyValue {
    string key;
    string value;
}

interface IDecentralizedApp {
    function request(string[] memory resource, KeyValue[] memory params)
        external
        view
        returns (uint16 statusCode, string memory body, KeyValue[] memory headers);
}

/// @title Site
/// @notice Serves a multi-file static site (HTML/CSS/JS) directly from
///         contract storage via ERC-4804 / EIP-5219, with no per-file
///         contract deployments. Each file's content is stored as an
///         ordered list of string chunks, written index-by-index across
///         many transactions (see onchain/upload.js), then concatenated
///         at read time.
contract Site is IDecentralizedApp {
    address public immutable owner;

    mapping(string => string[]) private chunks;
    mapping(string => bool) private registered;

    error NotOwner();
    error ChunkOutOfOrder();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Write chunk `index` of a file's content. Idempotent: if a
    ///         transaction for this exact index was already confirmed
    ///         on-chain, replaying it (e.g. after an interrupted upload
    ///         resends what it isn't sure landed) just overwrites it with
    ///         the same bytes - harmless. Only appends (grows the file) when
    ///         index equals the current length; a gap reverts rather than
    ///         silently producing a file with a hole in it.
    function setChunk(string calldata path, uint256 index, string calldata data) external onlyOwner {
        string[] storage c = chunks[path];
        if (index < c.length) {
            c[index] = data;
        } else if (index == c.length) {
            c.push(data);
            registered[path] = true;
        } else {
            revert ChunkOutOfOrder();
        }
    }

    /// @notice Wipe a file's stored content so it can be re-uploaded from
    ///         scratch (e.g. after fixing a mistake).
    function clearFile(string calldata path) external onlyOwner {
        delete chunks[path];
        registered[path] = false;
    }

    function fileChunkCount(string calldata path) external view returns (uint256) {
        return chunks[path].length;
    }

    function _content(string memory path) private view returns (string memory out) {
        string[] storage c = chunks[path];
        for (uint256 i; i < c.length; ++i) {
            out = string.concat(out, c[i]);
        }
    }

    function _join(string[] memory resource) private pure returns (string memory) {
        if (resource.length == 0) return "index.html";
        string memory out = resource[0];
        for (uint256 i = 1; i < resource.length; ++i) {
            out = string.concat(out, "/", resource[i]);
        }
        return out;
    }

    function _endsWith(bytes memory data, bytes memory suffix) private pure returns (bool) {
        if (data.length < suffix.length) return false;
        uint256 offset = data.length - suffix.length;
        for (uint256 i; i < suffix.length; ++i) {
            if (data[offset + i] != suffix[i]) return false;
        }
        return true;
    }

    function _contentType(string memory path) private pure returns (string memory) {
        bytes memory p = bytes(path);
        if (_endsWith(p, ".html")) return "text/html; charset=utf-8";
        if (_endsWith(p, ".css")) return "text/css; charset=utf-8";
        if (_endsWith(p, ".js")) return "text/javascript; charset=utf-8";
        return "application/octet-stream";
    }

    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    function request(string[] memory resource, KeyValue[] memory)
        external
        view
        returns (uint16 statusCode, string memory body, KeyValue[] memory headers)
    {
        string memory path = _join(resource);
        headers = new KeyValue[](1);

        if (!registered[path]) {
            statusCode = 404;
            body = string.concat("Not found: ", path);
            headers[0] = KeyValue("Content-Type", "text/plain; charset=utf-8");
            return (statusCode, body, headers);
        }

        statusCode = 200;
        body = _content(path);
        headers[0] = KeyValue("Content-Type", _contentType(path));
    }
}
