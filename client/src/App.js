import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import MyPRs from './pages/MyPRs';
import ReviewQueue from './pages/ReviewQueue';
import TeamRepos from './pages/TeamRepos';
import SignIn from './pages/SignIn';
export default function App() {
    return (_jsx(BrowserRouter, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/signin", element: _jsx(SignIn, {}) }), _jsx(Route, { path: "/*", element: _jsxs(_Fragment, { children: [_jsxs("nav", { style: { padding: '1rem', borderBottom: '1px solid #ccc', display: 'flex', gap: '1rem' }, children: [_jsx(NavLink, { to: "/my-prs", children: "My PRs" }), _jsx(NavLink, { to: "/queue", children: "Review Queue" }), _jsx(NavLink, { to: "/repos", children: "Team Repos" })] }), _jsx("main", { style: { padding: '1rem' }, children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(MyPRs, {}) }), _jsx(Route, { path: "/my-prs", element: _jsx(MyPRs, {}) }), _jsx(Route, { path: "/queue", element: _jsx(ReviewQueue, {}) }), _jsx(Route, { path: "/repos", element: _jsx(TeamRepos, {}) })] }) })] }) })] }) }));
}
