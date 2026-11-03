import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useSearchParams } from 'react-router-dom';
export default function SignIn() {
    const [params] = useSearchParams();
    const cancelled = params.get('cancelled') === '1';
    return (_jsxs("div", { style: { maxWidth: 400, margin: '4rem auto', textAlign: 'center' }, children: [_jsx("h1", { children: "PR Pulse" }), cancelled && (_jsx("p", { style: { color: '#c00' }, children: "Sign-in was cancelled." })), _jsx("a", { href: "/auth/github/login", children: _jsx("button", { type: "button", children: "Sign in with GitHub" }) })] }));
}
