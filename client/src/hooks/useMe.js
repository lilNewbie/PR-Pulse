import { useState, useEffect } from 'react';
import { apiFetch, ApiClientError } from '../api/client';
export function useMe() {
    const [state, setState] = useState({ status: 'loading' });
    useEffect(() => {
        apiFetch('/api/me')
            .then((me) => setState({ status: 'ok', me }))
            .catch((err) => {
            if (err instanceof ApiClientError && err.status === 401) {
                setState({ status: 'unauthenticated' });
            }
            else {
                setState({ status: 'error', message: err.message });
            }
        });
    }, []);
    return state;
}
