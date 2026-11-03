import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Owned by Alan (days 3-4 for queue logic)
import { useNavigate } from 'react-router-dom';
import { useMe } from '../hooks/useMe';
export default function ReviewQueue() {
    const navigate = useNavigate();
    const me = useMe();
    if (me.status === 'loading')
        return _jsx("p", { children: "Loading\u2026" });
    if (me.status === 'unauthenticated') {
        navigate('/signin');
        return null;
    }
    if (me.status === 'error')
        return _jsxs("p", { children: ["Error: ", me.message] });
    if (me.me.repos.length === 0) {
        return _jsx("p", { children: "No connected repositories you can access." });
    }
    // TODO (Alan, days 3-4): render ranked queue
    return _jsx("div", { children: "Review Queue" });
}
