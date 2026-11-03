export class ApiClientError extends Error {
    status;
    body;
    constructor(status, body) {
        super(body.error);
        this.status = status;
        this.body = body;
        this.name = 'ApiClientError';
    }
}
export async function apiFetch(path, init) {
    const res = await fetch(path, {
        ...init,
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...init?.headers,
        },
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: res.statusText })));
        throw new ApiClientError(res.status, body);
    }
    return res.json();
}
