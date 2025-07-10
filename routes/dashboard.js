// src/pages/Dashboard.jsx

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Layout from '../components/Layout';
import api from '../api/api';
import { useAuth } from '../context/AuthContext';
import VaultModal from '../components/VaultModal';
import VaultWithdrawModal from '../components/VaultWithdrawModal';
import InfoIcon from '../components/InfoIcon';

const Dashboard = () => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [isAllocateModalOpen, setAllocateModalOpen] = useState(false);
  const [isWithdrawModalOpen, setWithdrawModalOpen] = useState(false);
  const [selectedVault, setSelectedVault] = useState(null);

  // This function is now stable and will not cause re-renders.
  const fetchDashboardData = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/dashboard');
      setDashboardData(response.data);
      setError('');
    } catch (err) {
      console.error('[Dashboard] API call failed:', err);
      setError('Could not fetch dashboard data.');
    } finally {
      setLoading(false);
    }
  }, []); // The empty dependency array is the key.

  // This effect runs only once on mount.
  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  const handleOpenAllocateModal = (vault) => {
    setSelectedVault(vault);
    setAllocateModalOpen(true);
  };
  const handleOpenWithdrawModal = (vault) => {
    setSelectedVault(vault);
    setWithdrawModalOpen(true);
  };
  const handleActionSuccess = () => {
    fetchDashboardData();
  };

  const StatCardSkeleton = () => (
    <div className="stat-card skeleton">
      <div className="skeleton-text short"></div>
      <div className="skeleton-text long"></div>
    </div>
  );

  const renderContent = () => {
    if (loading) {
      return (
        <div className="stats-grid">
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
        </div>
      );
    }
    
    if (error || !dashboardData) {
      return <p className="error-message">{error || t('dashboard.no_data')}</p>;
    }

    const investedVaults = dashboardData.vaults.filter(v => parseFloat(v.tradable_capital) > 0);
    
    return (
      <>
        <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">{t('dashboard.total_value')}</span>
              <span className="stat-value">${(dashboardData.totalPortfolioValue || 0).toFixed(2)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">{t('dashboard.available_balance')}</span>
              <div className="stat-main">
                <span className="stat-value">${(dashboardData.availableBalance || 0).toFixed(2)}</span>
                <button onClick={() => navigate('/wallet')} className="btn-link">{t('dashboard.manage')}</button>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label-with-icon">
                <span className="stat-label">{t('dashboard.bonus_points')}</span>
                <Link to="/faq" className="info-icon-link" title={t('faq.q1_title')}>
                  <InfoIcon />
                </Link>
              </div>
              <span className="stat-value">${(dashboardData.totalBonusPoints || 0).toFixed(2)}</span>
            </div>
        </div>

        {investedVaults.length > 0 && (
          <>
            <h2 style={{ marginTop: '48px' }}>{t('dashboard.your_positions')}</h2>
            <div className="vaults-grid">
              {investedVaults.map(vault => (
                <div key={vault.vault_id} className="vault-card">
                  <h3>{vault.name}</h3>
                  <div className="vault-stat">
                    <span>{t('dashboard.tradable_capital')}</span>
                    <span>${parseFloat(vault.tradable_capital).toFixed(2)}</span>
                  </div>
                  <div className="vault-stat">
                    <span>{t('dashboard.pnl')}</span>
                    <span className={parseFloat(vault.pnl) >= 0 ? 'stat-value-positive' : 'stat-value-negative'}>
                      {parseFloat(vault.pnl) >= 0 ? '+' : ''}${parseFloat(vault.pnl).toFixed(2)}
                    </span>
                  </div>
                  <div className="vault-actions">
                    <button className="btn-secondary" onClick={() => handleOpenAllocateModal(vault)}>{t('dashboard.add_funds')}</button>
                    <button className="btn-secondary" onClick={() => handleOpenWithdrawModal(vault)}>{t('dashboard.withdraw')}</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <h2 style={{ marginTop: '48px' }}>{t('dashboard.available_strategies')}</h2>
        <div className="vaults-grid">
          {dashboardData.vaults.map(vault => {
            if (investedVaults.find(v => v.vault_id === vault.vault_id)) return null;
            const isActive = vault.status === 'active';
            return (
              <div key={vault.vault_id} className={`vault-card ${isActive ? 'cta' : 'placeholder'}`}>
                <h3>{vault.name}</h3>
                <p className="cta-text">{vault.description}</p>
                <div className="vault-actions">
                  {isActive ? (
                    <button className="btn-primary" onClick={() => handleOpenAllocateModal(vault)}>
                      {t('dashboard.allocate_funds')}
                    </button>
                  ) : (
                    <span className="placeholder-text">{t('dashboard.coming_soon')}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <>
      <Layout>
        <div className="dashboard-container">
          <h1>{t('dashboard.welcome', { username: user?.username || 'User' })}</h1>
          {renderContent()}
        </div>
      </Layout>

      {dashboardData && (
        <VaultModal
            isOpen={isAllocateModalOpen}
            onClose={() => setAllocateModalOpen(false)}
            vault={selectedVault}
            availableBalance={dashboardData.availableBalance}
            onAllocationSuccess={handleActionSuccess}
        />
      )}
      
      {dashboardData && (
        <VaultWithdrawModal
            isOpen={isWithdrawModalOpen}
            onClose={() => setWithdrawModalOpen(false)}
            vault={selectedVault}
            onWithdrawalSuccess={handleActionSuccess}
        />
      )}
    </>
  );
};

export default Dashboard;