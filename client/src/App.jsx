import { useEffect, useState } from 'react';

const apiBase = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const statuses = [
  ['submitted', 'Submitted'],
  ['in_progress', 'In progress'],
  ['waiting_on_employee', 'Waiting on you'],
  ['resolved', 'Resolved'],
  ['closed', 'Closed'],
];

async function apiRequest(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function Brand() {
  return <a className="brand" href="#home" aria-label="Arrowstack home"><span className="brand-mark">a</span><span>arrowstack</span></a>;
}

function AuthScreen({ onAuthenticated, notice }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isRegistering = mode === 'register';

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest(`/api/auth/${isRegistering ? 'register' : 'login'}`, {
        method: 'POST',
        body: { email, password, ...(isRegistering ? { displayName } : {}) },
      });
      onAuthenticated(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <Brand />
        <div className="auth-intro"><span className="auth-kicker">EMPLOYEE SERVICE DESK</span><h1>{isRegistering ? 'Create your account' : 'Welcome back'}</h1><p>{isRegistering ? 'Create an employee account to manage your service requests.' : 'Sign in to view and manage your service requests.'}</p></div>
        {notice && <div className="notice-banner" role="status">{notice}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <form className="auth-form" onSubmit={submit}>
          {isRegistering && <label>Full name<input autoComplete="name" maxLength="100" onChange={(event) => setDisplayName(event.target.value)} required value={displayName} /></label>}
          <label>Email address<input autoComplete="email" maxLength="254" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
          <label>Password<input autoComplete={isRegistering ? 'new-password' : 'current-password'} maxLength="72" minLength={isRegistering ? 12 : undefined} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
          {isRegistering && <span className="field-hint">Use at least 12 characters. Passwords are limited to 72 UTF-8 bytes.</span>}
          <button className="primary-button form-submit" disabled={busy} type="submit">{busy ? 'Please wait…' : isRegistering ? 'Create employee account' : 'Sign in'} <span aria-hidden="true">→</span></button>
        </form>
        <p className="auth-switch">{isRegistering ? 'Already have an account?' : 'New to the service desk?'} <button onClick={() => { setError(''); setMode(isRegistering ? 'login' : 'register'); }} type="button">{isRegistering ? 'Sign in' : 'Create an account'}</button></p>
        <p className="auth-footnote">Employee accounts are created with the employee role.</p>
      </section>
      <aside className="auth-aside"><div className="aside-glow"/><div className="aside-content"><span className="hero-kicker">HERE FOR YOUR WORKDAY</span><h2>Support that<br />keeps you moving.</h2><p>Request help, follow progress, and find your service history in one place.</p><div className="aside-check"><span>✓</span> A clear view of every request</div><div className="aside-check"><span>✓</span> Updates from your service team</div></div><span className="aside-caption">ARROWSTACK · EMPLOYEE SERVICES</span></aside>
    </main>
  );
}

function StatusBadge({ status }) {
  const label = statuses.find(([value]) => value === status)?.[1] ?? status;
  return <span className={`status-badge status-${status}`}>{label}</span>;
}

function RequestForm({ categories, onCancel, onCreated, token }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categorySlug, setCategorySlug] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest('/api/requests', {
        token,
        method: 'POST',
        body: { title, description, categorySlug },
      });
      onCreated(result.request);
    } catch (requestError) {
      if (requestError.status === 401) return onCancel('Your session expired. Sign in again to continue.');
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="request-form-card" aria-labelledby="create-request-heading">
      <div className="card-heading"><div><span className="section-eyebrow">NEW SERVICE REQUEST</span><h2 id="create-request-heading">Tell us what you need</h2></div><button className="quiet-button" onClick={() => onCancel()} type="button">Cancel</button></div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <form className="request-form" onSubmit={submit}>
        <label>Request title<input autoFocus maxLength="160" onChange={(event) => setTitle(event.target.value)} placeholder="A short summary of your request" required value={title} /></label>
        <label>Service category<select onChange={(event) => setCategorySlug(event.target.value)} required value={categorySlug}><option disabled value="">Choose a category</option>{categories.map((category) => <option key={category.id} value={category.slug}>{category.name}</option>)}</select></label>
        <label className="description-field">Description<textarea maxLength="10000" onChange={(event) => setDescription(event.target.value)} placeholder="Share the details our team will need to help you." required rows="5" value={description} /></label>
        <div className="form-footer"><span>Your request will be visible to you and the service team.</span><button className="primary-button" disabled={busy || categories.length === 0} type="submit">{busy ? 'Submitting…' : 'Submit request'} <span aria-hidden="true">→</span></button></div>
      </form>
    </section>
  );
}

function RequestConversation({ requestId, token, staff, onSessionExpired, refreshKey = 0 }) {
  const [comments, setComments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [commentBody, setCommentBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const base = staff ? '/api/staff/requests' : '/api/requests';

  useEffect(() => {
    let current = true;
    setLoading(true);
    Promise.all([
      apiRequest(`${base}/${requestId}/comments`, { token }),
      apiRequest(`${base}/${requestId}/activity`, { token }),
    ]).then(([commentResult, activityResult]) => {
      if (!current) return;
      setComments(commentResult.comments);
      setActivity(activityResult.activity);
      setError('');
    }).catch((requestError) => {
      if (!current) return;
      if (requestError.status === 401) onSessionExpired();
      else setError(requestError.message);
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [base, requestId, token, reload, refreshKey, onSessionExpired]);

  async function submitComment(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await apiRequest(`${base}/${requestId}/comments`, { token, method: 'POST', body: { body: commentBody } });
      setCommentBody('');
      setReload((value) => value + 1);
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired();
      else setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  return <section className="conversation" aria-label="Comments and activity">
    <div className="conversation-heading"><span className="section-eyebrow">CONVERSATION</span><h3>Comments</h3></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <form className="comment-form" onSubmit={submitComment}>
      <label htmlFor={`comment-${requestId}`}>Add a comment</label>
      <textarea id={`comment-${requestId}`} maxLength="5000" onChange={(event) => setCommentBody(event.target.value)} placeholder="Share an update or ask a question" required rows="3" value={commentBody} />
      <button className="primary-button" disabled={saving || !commentBody.trim()} type="submit">{saving ? 'Adding…' : 'Add comment'}</button>
    </form>
    {loading ? <p className="muted-copy">Loading conversation…</p> : comments.length === 0 ? <p className="muted-copy">No comments yet.</p> : <ol className="comment-list">{comments.map((comment) => <li key={comment.id}><div className="conversation-meta"><strong>{comment.author.displayName}</strong><span>{formatDate(comment.createdAt)}</span>{comment.isInternal && <span className="internal-label">Staff only</span>}</div><p>{comment.body}</p></li>)}</ol>}
    <details className="activity-history"><summary>Activity history <span>{activity.length}</span></summary>{loading ? <p className="muted-copy">Loading history…</p> : activity.length === 0 ? <p className="muted-copy">No activity recorded.</p> : <ol className="activity-list">{activity.map((item) => <li key={item.id}><span className="activity-dot"/><div><strong>{item.action.replaceAll('_', ' ')}</strong><span>{item.actor?.displayName ?? 'System'} · {formatDate(item.createdAt)}</span></div></li>)}</ol>}</details>
  </section>;
}

function RequestDetail({ request, loading, error, onClose, token, onSessionExpired }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-labelledby="request-detail-title" aria-modal="true" className="detail-modal" role="dialog">
        <div className="detail-top"><span className="section-eyebrow">REQUEST DETAILS</span><button aria-label="Close details" className="close-button" onClick={onClose} type="button">×</button></div>
        {loading && <p className="muted-copy">Loading request…</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {request && <><div className="detail-meta"><StatusBadge status={request.status} /><span>{request.category.name}</span><span>Submitted {formatDate(request.createdAt)}</span></div><h2 id="request-detail-title">{request.title}</h2><p className="detail-description">{request.description}</p><RequestConversation onSessionExpired={onSessionExpired} requestId={request.id} staff={false} token={token} /><div className="detail-reference">Request reference <strong>{request.id}</strong></div></>}
      </section>
    </div>
  );
}

function RequestDashboard({ token, user, onLogout, onSessionExpired }) {
  const [requests, setRequests] = useState([]);
  const [categories, setCategories] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, totalItems: 0, totalPages: 1 });
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    setBusy(true);
    setError('');
    Promise.all([
      apiRequest('/api/requests/categories', { token }),
      apiRequest(`/api/requests?page=${page}&pageSize=10${status ? `&status=${encodeURIComponent(status)}` : ''}`, { token }),
    ]).then(([categoryResult, requestResult]) => {
      if (!current) return;
      setCategories(categoryResult.categories);
      setRequests(requestResult.requests);
      setPagination(requestResult.pagination);
    }).catch((requestError) => {
      if (!current) return;
      if (requestError.status === 401) onSessionExpired();
      else setError(requestError.message);
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [token, page, status, reload, onSessionExpired]);

  useEffect(() => {
    if (!selectedRequest) return undefined;
    let current = true;
    setDetailLoading(true);
    setDetailError('');
    apiRequest(`/api/requests/${selectedRequest}`, { token })
      .then((result) => { if (current) setSelectedRequest(result.request); })
      .catch((requestError) => {
        if (!current) return;
        if (requestError.status === 401) onSessionExpired();
        else setDetailError(requestError.message);
      })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [selectedRequest?.id ?? selectedRequest, token, onSessionExpired]);

  async function logout() {
    try {
      await apiRequest('/api/auth/logout', { token, method: 'POST' });
      onLogout();
    } catch (requestError) {
      if (requestError.status === 401) onLogout();
      else setError(requestError.message);
    }
  }

  function onCreated(request) {
    setShowForm(false);
    setStatus('');
    setPage(1);
    setNotice(`Request submitted: ${request.title}`);
    setReload((value) => value + 1);
  }

  const initials = user.displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="app-shell">
      <aside className="sidebar"><Brand /><div className="workspace-label">WORKSPACE</div><nav aria-label="Main navigation"><a className="nav-link active" href="#requests"><span className="nav-icon" aria-hidden="true">▤</span>My requests</a></nav><div className="sidebar-bottom"><div className="support-card"><span className="support-icon">?</span><div><strong>Need a hand?</strong><span>Choose a category to get started.</span></div></div><div className="profile"><div className="avatar">{initials}</div><div className="profile-copy"><strong>{user.displayName}</strong><span>Employee</span></div></div></div></aside>
      <main className="main-area"><header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>My requests</strong></div><div className="topbar-actions"><span className="account-email">{user.email}</span><button className="quiet-button" onClick={logout} type="button">Sign out</button></div></header>
        <div className="page-content request-page">
          <section className="welcome-row"><div><div className="eyebrow">EMPLOYEE SERVICE DESK</div><h1>Your service requests</h1><p>Submit a request and follow its progress from here.</p></div><button className="primary-button" onClick={() => { setNotice(''); setShowForm((value) => !value); }} type="button"><span>＋</span> New request</button></section>
          {notice && <div className="notice-banner" role="status">{notice}</div>}
          {showForm && <RequestForm categories={categories} onCancel={(message) => { setShowForm(false); if (message) onSessionExpired(message); }} onCreated={onCreated} token={token} />}
          <section className="request-list-card" aria-labelledby="request-list-heading"><div className="list-heading"><div><h2 id="request-list-heading">My requests <span className="count-pill">{pagination.totalItems}</span></h2><p>Only you can see requests submitted from your account.</p></div><label className="filter-label">Status<select onChange={(event) => { setPage(1); setStatus(event.target.value); }} value={status}><option value="">All statuses</option>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            {error && <div className="error-banner" role="alert">{error}</div>}
            {busy ? <div className="list-message">Loading your requests…</div> : requests.length === 0 ? <div className="list-message empty-list"><div className="empty-icon">▤</div><h3>No requests yet</h3><p>When you need help, create a request and it will appear here.</p><button className="text-button" onClick={() => setShowForm(true)} type="button">Create your first request <span>→</span></button></div> : <div className="request-list">{requests.map((request) => <button className="request-row" key={request.id} onClick={() => setSelectedRequest(request.id)} type="button"><span className="request-category-icon" aria-hidden="true">{request.category.slug === 'it' ? '⌘' : request.category.slug === 'hr' ? '♧' : '⌂'}</span><span className="request-summary"><strong>{request.title}</strong><span>{request.category.name} <i>·</i> Updated {formatDate(request.updatedAt)}</span></span><StatusBadge status={request.status} /><span className="request-arrow" aria-hidden="true">→</span></button>)}</div>}
            {!busy && <div className="pagination"><span>Page {pagination.page} of {pagination.totalPages}</span><div><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">Previous</button><button disabled={page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next</button></div></div>}
          </section>
          <footer>© 2026 Arrowstack <span>·</span> Service Desk</footer>
        </div>
      </main>
      {selectedRequest && <RequestDetail error={detailError} loading={detailLoading} onClose={() => setSelectedRequest(null)} onSessionExpired={onSessionExpired} request={typeof selectedRequest === 'object' ? selectedRequest : null} token={token} />}
    </div>
  );
}

function StaffDashboard({ token, user, onLogout, onSessionExpired }) {
  const [requests, setRequests] = useState([]);
  const [staff, setStaff] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, totalItems: 0, totalPages: 1 });
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [assignment, setAssignment] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [editStatus, setEditStatus] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editAssignee, setEditAssignee] = useState('');
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    setBusy(true);
    setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: '10', assignment });
    if (status) params.set('status', status);
    Promise.all([
      apiRequest(`/api/staff/requests?${params}`, { token }),
      apiRequest('/api/staff/users', { token }),
    ]).then(([queue, staffResult]) => {
      if (!current) return;
      setRequests(queue.requests);
      setPagination(queue.pagination);
      setStaff(staffResult.staff);
    }).catch((requestError) => {
      if (!current) return;
      if (requestError.status === 401) onSessionExpired();
      else setError(requestError.message);
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [token, page, status, assignment, reload, onSessionExpired]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let current = true;
    setSelectedRequest(null);
    setDetailError('');
    apiRequest(`/api/staff/requests/${selectedId}`, { token })
      .then(({ request }) => {
        if (!current) return;
        setSelectedRequest(request);
        setEditStatus(request.status);
        setEditPriority(request.priority);
        setEditAssignee(request.assignedTo?.id ?? '');
      })
      .catch((requestError) => {
        if (!current) return;
        if (requestError.status === 401) onSessionExpired();
        else setDetailError(requestError.message);
      });
    return () => { current = false; };
  }, [selectedId, token, onSessionExpired]);

  async function logout() {
    try {
      await apiRequest('/api/auth/logout', { token, method: 'POST' });
      onLogout();
    } catch (requestError) {
      if (requestError.status === 401) onLogout();
      else setError(requestError.message);
    }
  }

  async function saveChanges(event) {
    event.preventDefault();
    if (!selectedRequest) return;
    setSaving(true);
    setDetailError('');
    setNotice('');
    try {
      const result = await apiRequest(`/api/staff/requests/${selectedRequest.id}`, {
        token,
        method: 'PATCH',
        body: {
          assignedTo: editAssignee || null,
          status: editStatus,
          priority: editPriority,
        },
      });
      setSelectedRequest(result.request);
      setEditStatus(result.request.status);
      setEditPriority(result.request.priority);
      setEditAssignee(result.request.assignedTo?.id ?? '');
      setNotice('Request updated. Changes have been added to its activity history.');
      setReload((value) => value + 1);
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired();
      else setDetailError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  const initials = user.displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="app-shell">
      <aside className="sidebar"><Brand /><div className="workspace-label">WORKSPACE</div><nav aria-label="Main navigation"><a className="nav-link active" href="#staff-queue"><span className="nav-icon" aria-hidden="true">▤</span>Request queue</a></nav><div className="sidebar-bottom"><div className="support-card"><span className="support-icon">✓</span><div><strong>Service team</strong><span>Keep requests moving.</span></div></div><div className="profile"><div className="avatar">{initials}</div><div className="profile-copy"><strong>{user.displayName}</strong><span>Staff</span></div></div></div></aside>
      <main className="main-area"><header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>Request queue</strong></div><div className="topbar-actions"><span className="account-email">{user.email}</span><button className="quiet-button" onClick={logout} type="button">Sign out</button></div></header>
        <div className="page-content request-page staff-page">
          <section className="welcome-row"><div><div className="eyebrow">STAFF SERVICE DESK</div><h1>Request triage</h1><p>Review incoming requests, assign an owner, and keep status current.</p></div><span className="staff-total">{pagination.totalItems} requests</span></section>
          {notice && <div className="notice-banner" role="status">{notice}</div>}
          <section className="request-list-card" aria-labelledby="staff-queue-heading"><div className="list-heading"><div><h2 id="staff-queue-heading">Service queue <span className="count-pill">{pagination.totalItems}</span></h2><p>Request access and updates are restricted to staff accounts.</p></div><div className="staff-filters"><label className="filter-label">Status<select onChange={(event) => { setPage(1); setStatus(event.target.value); }} value={status}><option value="">All statuses</option>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="filter-label">Assigned<select onChange={(event) => { setPage(1); setAssignment(event.target.value); }} value={assignment}><option value="all">Everyone</option><option value="unassigned">Unassigned</option><option value="mine">Assigned to me</option></select></label></div></div>
            {error && <div className="error-banner" role="alert">{error}</div>}
            {busy ? <div className="list-message" role="status">Loading the service queue…</div> : requests.length === 0 ? <div className="list-message empty-list"><div className="empty-icon">▤</div><h3>No matching requests</h3><p>Try another status or assignment filter.</p></div> : <div className="request-list">{requests.map((request) => <button className="request-row staff-request-row" key={request.id} onClick={() => setSelectedId(request.id)} type="button"><span className="request-category-icon" aria-hidden="true">{request.category.slug === 'it' ? '⌘' : request.category.slug === 'hr' ? '♧' : '⌂'}</span><span className="request-summary"><strong>{request.title}</strong><span>{request.category.name} <i>·</i> From {request.requester.displayName} <i>·</i> {request.assignedTo?.displayName ?? 'Unassigned'}</span></span><span className={`priority-label priority-${request.priority}`}>{request.priority}</span><StatusBadge status={request.status} /><span className="request-arrow" aria-hidden="true">→</span></button>)}</div>}
            {!busy && <div className="pagination"><span>Page {pagination.page} of {pagination.totalPages}</span><div><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">Previous</button><button disabled={page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next</button></div></div>}
          </section>
          <footer>© 2026 Arrowstack <span>·</span> Service Desk</footer>
        </div>
      </main>
      {selectedId && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(''); }}><section aria-labelledby="staff-detail-heading" aria-modal="true" className="detail-modal staff-detail-modal" role="dialog"><div className="detail-top"><span className="section-eyebrow">STAFF TRIAGE</span><button aria-label="Close request" className="close-button" onClick={() => setSelectedId('')} type="button">×</button></div>{detailError && <div className="error-banner" role="alert">{detailError}</div>}{!selectedRequest ? <p className="muted-copy">Loading request…</p> : <><div className="detail-meta"><StatusBadge status={selectedRequest.status} /><span>{selectedRequest.category.name}</span><span>Submitted {formatDate(selectedRequest.createdAt)}</span></div><h2 id="staff-detail-heading">{selectedRequest.title}</h2><p className="detail-description">{selectedRequest.description}</p><div className="staff-requester"><span>Submitted by</span><strong>{selectedRequest.requester.displayName}</strong><span>{selectedRequest.requester.email}</span></div><RequestConversation onSessionExpired={onSessionExpired} refreshKey={reload} requestId={selectedRequest.id} staff token={token} />{notice && <div className="notice-banner" role="status">{notice}</div>}<form className="staff-edit-form" onSubmit={saveChanges}><label>Assigned staff<select onChange={(event) => setEditAssignee(event.target.value)} value={editAssignee}><option value="">Unassigned</option>{staff.map((member) => <option key={member.id} value={member.id}>{member.displayName} ({member.email})</option>)}</select></label><label>Status<select onChange={(event) => setEditStatus(event.target.value)} value={editStatus}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Priority<select onChange={(event) => setEditPriority(event.target.value)} value={editPriority}>{['low', 'medium', 'high', 'urgent'].map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label><button className="primary-button" disabled={saving} type="submit">{saving ? 'Saving…' : 'Save changes'} <span aria-hidden="true">→</span></button></form><div className="detail-reference">Request reference <strong>{selectedRequest.id}</strong></div></>}</section></div>}
    </div>
  );
}

function App() {
  const [token, setToken] = useState(() => (typeof window === 'undefined' ? null : window.sessionStorage.getItem('arrowstack.accessToken')));
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(token));
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!token) return undefined;
    let current = true;
    apiRequest('/api/auth/me', { token }).then(({ user: currentUser }) => {
      if (current) setUser(currentUser);
    }).catch(() => {
      if (!current) return;
      window.sessionStorage.removeItem('arrowstack.accessToken');
      setToken(null);
      setNotice('Your session ended. Sign in again to continue.');
    }).finally(() => { if (current) setChecking(false); });
    return () => { current = false; };
  }, [token]);

  function handleAuthenticated(result) {
    window.sessionStorage.setItem('arrowstack.accessToken', result.token);
    setToken(result.token);
    setUser(result.user);
    setNotice('');
  }

  function handleLogout(message = '') {
    window.sessionStorage.removeItem('arrowstack.accessToken');
    setToken(null);
    setUser(null);
    setNotice(message);
  }

  if (checking) return <main className="loading-page" role="status">Checking your session…</main>;
  if (!token || !user) return <AuthScreen notice={notice} onAuthenticated={handleAuthenticated} />;
  const onSessionExpired = (message) => handleLogout(message ?? 'Your session expired. Sign in again to continue.');
  if (user.role === 'staff') return <StaffDashboard onLogout={() => handleLogout()} onSessionExpired={onSessionExpired} token={token} user={user} />;
  return <RequestDashboard onLogout={() => handleLogout()} onSessionExpired={onSessionExpired} token={token} user={user} />;
}

export default App;
