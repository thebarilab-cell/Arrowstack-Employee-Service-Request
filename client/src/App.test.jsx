import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App.jsx';

describe('service desk application', () => {
  it('renders a sign-in entry point for the employee request workspace', () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain('Welcome back');
    expect(markup).toContain('Sign in');
    expect(markup).toContain('Create an account');
  });
});
