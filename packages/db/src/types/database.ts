export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agencies: {
        Row: {
          acronym: string | null
          agency_type: string
          contact_email: string | null
          created_at: string
          description: string | null
          founded_year: number | null
          governing_body_id: string | null
          id: string
          is_active: boolean
          jurisdiction_id: string
          metadata: Json
          name: string
          parent_agency_id: string | null
          personnel_fte: number | null
          short_name: string | null
          source_ids: Json
          updated_at: string
          usaspending_agency_id: string | null
          usaspending_subtier_id: string | null
          website_url: string | null
          wikidata_id: string | null
        }
        Insert: {
          acronym?: string | null
          agency_type?: string
          contact_email?: string | null
          created_at?: string
          description?: string | null
          founded_year?: number | null
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          jurisdiction_id: string
          metadata?: Json
          name: string
          parent_agency_id?: string | null
          personnel_fte?: number | null
          short_name?: string | null
          source_ids?: Json
          updated_at?: string
          usaspending_agency_id?: string | null
          usaspending_subtier_id?: string | null
          website_url?: string | null
          wikidata_id?: string | null
        }
        Update: {
          acronym?: string | null
          agency_type?: string
          contact_email?: string | null
          created_at?: string
          description?: string | null
          founded_year?: number | null
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          jurisdiction_id?: string
          metadata?: Json
          name?: string
          parent_agency_id?: string | null
          personnel_fte?: number | null
          short_name?: string | null
          source_ids?: Json
          updated_at?: string
          usaspending_agency_id?: string | null
          usaspending_subtier_id?: string | null
          website_url?: string | null
          wikidata_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agencies_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agencies_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agencies_parent_agency_id_fkey"
            columns: ["parent_agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      agenda_items: {
        Row: {
          created_at: string
          description: string | null
          id: string
          item_type: string | null
          meeting_id: string
          metadata: Json
          outcome: string | null
          proposal_id: string | null
          sequence: number
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          item_type?: string | null
          meeting_id: string
          metadata?: Json
          outcome?: string | null
          proposal_id?: string | null
          sequence: number
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          item_type?: string | null
          meeting_id?: string
          metadata?: Json
          outcome?: string | null
          proposal_id?: string | null
          sequence?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agenda_items_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agenda_items_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "agenda_items_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_summary_cache: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          metadata: Json
          model: string
          summary_text: string
          summary_type: string
          tokens_used: number | null
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          metadata?: Json
          model: string
          summary_text: string
          summary_type: string
          tokens_used?: number | null
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          metadata?: Json
          model?: string
          summary_text?: string
          summary_type?: string
          tokens_used?: number | null
        }
        Relationships: []
      }
      api_usage_logs: {
        Row: {
          cost_cents: number
          created_at: string
          endpoint: string | null
          id: string
          input_tokens: number | null
          metadata: Json
          model: string | null
          output_tokens: number | null
          service: string
          tokens_used: number | null
        }
        Insert: {
          cost_cents?: number
          created_at?: string
          endpoint?: string | null
          id?: string
          input_tokens?: number | null
          metadata?: Json
          model?: string | null
          output_tokens?: number | null
          service: string
          tokens_used?: number | null
        }
        Update: {
          cost_cents?: number
          created_at?: string
          endpoint?: string | null
          id?: string
          input_tokens?: number | null
          metadata?: Json
          model?: string | null
          output_tokens?: number | null
          service?: string
          tokens_used?: number | null
        }
        Relationships: []
      }
      bill_details: {
        Row: {
          bill_number: string
          chamber: string | null
          congress_gov_url: string | null
          congress_number: number | null
          fiscal_impact_cents: number | null
          jurisdiction_id: string
          legistar_matter_id: string | null
          primary_sponsor_id: string | null
          proposal_id: string
          session: string | null
        }
        Insert: {
          bill_number: string
          chamber?: string | null
          congress_gov_url?: string | null
          congress_number?: number | null
          fiscal_impact_cents?: number | null
          jurisdiction_id: string
          legistar_matter_id?: string | null
          primary_sponsor_id?: string | null
          proposal_id: string
          session?: string | null
        }
        Update: {
          bill_number?: string
          chamber?: string | null
          congress_gov_url?: string | null
          congress_number?: number | null
          fiscal_impact_cents?: number | null
          jurisdiction_id?: string
          legistar_matter_id?: string | null
          primary_sponsor_id?: string | null
          proposal_id?: string
          session?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bill_details_primary_sponsor_id_fkey"
            columns: ["primary_sponsor_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "bill_details_primary_sponsor_id_fkey"
            columns: ["primary_sponsor_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bill_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "bill_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      career_history: {
        Row: {
          created_at: string
          ended_at: string | null
          governing_body_id: string | null
          id: string
          is_government: boolean
          metadata: Json
          official_id: string
          organization: string
          revolving_door_explanation: string | null
          revolving_door_flag: boolean
          role_title: string | null
          started_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          ended_at?: string | null
          governing_body_id?: string | null
          id?: string
          is_government?: boolean
          metadata?: Json
          official_id: string
          organization: string
          revolving_door_explanation?: string | null
          revolving_door_flag?: boolean
          role_title?: string | null
          started_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          ended_at?: string | null
          governing_body_id?: string | null
          id?: string
          is_government?: boolean
          metadata?: Json
          official_id?: string
          organization?: string
          revolving_door_explanation?: string | null
          revolving_door_flag?: boolean
          role_title?: string | null
          started_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "career_history_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "career_history_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "career_history_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      case_details: {
        Row: {
          case_name: string | null
          court_name: string
          courtlistener_id: string | null
          docket_number: string
          filed_at: string | null
          outcome: string | null
          outcome_at: string | null
          pacer_id: string | null
          parties: Json
          proposal_id: string
        }
        Insert: {
          case_name?: string | null
          court_name: string
          courtlistener_id?: string | null
          docket_number: string
          filed_at?: string | null
          outcome?: string | null
          outcome_at?: string | null
          pacer_id?: string | null
          parties?: Json
          proposal_id: string
        }
        Update: {
          case_name?: string | null
          court_name?: string
          courtlistener_id?: string | null
          docket_number?: string
          filed_at?: string | null
          outcome?: string | null
          outcome_at?: string | null
          pacer_id?: string | null
          parties?: Json
          proposal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "case_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_comments: {
        Row: {
          body: string
          created_at: string
          id: string
          is_deleted: boolean
          metadata: Json
          onchain_tx_hash: string | null
          parent_id: string | null
          position: string | null
          proposal_id: string
          updated_at: string
          upvotes: number
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          is_deleted?: boolean
          metadata?: Json
          onchain_tx_hash?: string | null
          parent_id?: string | null
          position?: string | null
          proposal_id: string
          updated_at?: string
          upvotes?: number
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_deleted?: boolean
          metadata?: Json
          onchain_tx_hash?: string | null
          parent_id?: string | null
          position?: string | null
          proposal_id?: string
          updated_at?: string
          upvotes?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "civic_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_comments_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_comments_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_credit_transactions: {
        Row: {
          amount: number
          balance_after: number
          created_at: string
          description: string | null
          id: string
          onchain_tx_hash: string | null
          related_entity_id: string | null
          related_entity_type: string | null
          transaction_type: string
          user_id: string
        }
        Insert: {
          amount: number
          balance_after: number
          created_at?: string
          description?: string | null
          id?: string
          onchain_tx_hash?: string | null
          related_entity_id?: string | null
          related_entity_type?: string | null
          transaction_type: string
          user_id: string
        }
        Update: {
          amount?: number
          balance_after?: number
          created_at?: string
          description?: string | null
          id?: string
          onchain_tx_hash?: string | null
          related_entity_id?: string | null
          related_entity_type?: string | null
          transaction_type?: string
          user_id?: string
        }
        Relationships: []
      }
      civic_initiative_argument_flags: {
        Row: {
          argument_id: string
          created_at: string
          flag_type: Database["public"]["Enums"]["argument_flag"]
          id: string
          user_id: string
        }
        Insert: {
          argument_id: string
          created_at?: string
          flag_type?: Database["public"]["Enums"]["argument_flag"]
          id?: string
          user_id: string
        }
        Update: {
          argument_id?: string
          created_at?: string
          flag_type?: Database["public"]["Enums"]["argument_flag"]
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_argument_flags_argument_id_fkey"
            columns: ["argument_id"]
            isOneToOne: false
            referencedRelation: "civic_initiative_arguments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_argument_flags_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_argument_votes: {
        Row: {
          argument_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          argument_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          argument_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_argument_votes_argument_id_fkey"
            columns: ["argument_id"]
            isOneToOne: false
            referencedRelation: "civic_initiative_arguments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_argument_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_arguments: {
        Row: {
          author_id: string | null
          body: string
          comment_type: string | null
          created_at: string
          flag_count: number
          id: string
          initiative_id: string
          is_deleted: boolean
          parent_id: string | null
          side: Database["public"]["Enums"]["argument_side"] | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          comment_type?: string | null
          created_at?: string
          flag_count?: number
          id?: string
          initiative_id: string
          is_deleted?: boolean
          parent_id?: string | null
          side?: Database["public"]["Enums"]["argument_side"] | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          comment_type?: string | null
          created_at?: string
          flag_count?: number
          id?: string
          initiative_id?: string
          is_deleted?: boolean
          parent_id?: string | null
          side?: Database["public"]["Enums"]["argument_side"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_arguments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_arguments_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_arguments_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_arguments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "civic_initiative_arguments"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_follows: {
        Row: {
          created_at: string
          id: string
          initiative_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          initiative_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          initiative_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_follows_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_follows_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_follows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_milestone_events: {
        Row: {
          constituent_count: number
          fired_at: string
          id: string
          initiative_id: string
          milestone: string
          total_count: number
        }
        Insert: {
          constituent_count?: number
          fired_at?: string
          id?: string
          initiative_id: string
          milestone: string
          total_count?: number
        }
        Update: {
          constituent_count?: number
          fired_at?: string
          id?: string
          initiative_id?: string
          milestone?: string
          total_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_milestone_events_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_milestone_events_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_proposal_links: {
        Row: {
          created_at: string
          id: string
          initiative_id: string
          linked_by: string
          proposal_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          initiative_id: string
          linked_by: string
          proposal_id: string
        }
        Update: {
          created_at?: string
          id?: string
          initiative_id?: string
          linked_by?: string
          proposal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_proposal_links_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_proposal_links_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_proposal_links_linked_by_fkey"
            columns: ["linked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_proposal_links_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_proposal_links_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_responses: {
        Row: {
          body_text: string | null
          committee_referred: string | null
          created_at: string
          id: string
          initiative_id: string
          is_verified_staff: boolean
          official_id: string
          responded_at: string | null
          response_type: Database["public"]["Enums"]["official_response_type"]
          window_closes_at: string
          window_opened_at: string
        }
        Insert: {
          body_text?: string | null
          committee_referred?: string | null
          created_at?: string
          id?: string
          initiative_id: string
          is_verified_staff?: boolean
          official_id: string
          responded_at?: string | null
          response_type?: Database["public"]["Enums"]["official_response_type"]
          window_closes_at?: string
          window_opened_at?: string
        }
        Update: {
          body_text?: string | null
          committee_referred?: string | null
          created_at?: string
          id?: string
          initiative_id?: string
          is_verified_staff?: boolean
          official_id?: string
          responded_at?: string | null
          response_type?: Database["public"]["Enums"]["official_response_type"]
          window_closes_at?: string
          window_opened_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_responses_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_responses_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_responses_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "civic_initiative_responses_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_signatures: {
        Row: {
          district: string | null
          id: string
          initiative_id: string
          signed_at: string
          user_id: string
          verification_tier: Database["public"]["Enums"]["signature_verification"]
        }
        Insert: {
          district?: string | null
          id?: string
          initiative_id: string
          signed_at?: string
          user_id: string
          verification_tier?: Database["public"]["Enums"]["signature_verification"]
        }
        Update: {
          district?: string | null
          id?: string
          initiative_id?: string
          signed_at?: string
          user_id?: string
          verification_tier?: Database["public"]["Enums"]["signature_verification"]
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_signatures_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_signatures_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_signatures_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_upvotes: {
        Row: {
          created_at: string
          id: string
          initiative_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          initiative_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          initiative_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_upvotes_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_upvotes_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_upvotes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_versions: {
        Row: {
          body_md: string
          created_at: string
          edited_by: string | null
          id: string
          initiative_id: string
          title: string
          version_number: number
        }
        Insert: {
          body_md: string
          created_at?: string
          edited_by?: string | null
          id?: string
          initiative_id: string
          title: string
          version_number: number
        }
        Update: {
          body_md?: string
          created_at?: string
          edited_by?: string | null
          id?: string
          initiative_id?: string
          title?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_versions_edited_by_fkey"
            columns: ["edited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_versions_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_versions_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_queue: {
        Row: {
          created_at: string
          id: string
          jurisdiction_id: string
          reason: string | null
          rejection_reason: string | null
          requested_by: string
          resolved_at: string | null
          status: string
          upvote_count: number
        }
        Insert: {
          created_at?: string
          id?: string
          jurisdiction_id: string
          reason?: string | null
          rejection_reason?: string | null
          requested_by: string
          resolved_at?: string | null
          status?: string
          upvote_count?: number
        }
        Update: {
          created_at?: string
          id?: string
          jurisdiction_id?: string
          reason?: string | null
          rejection_reason?: string | null
          requested_by?: string
          resolved_at?: string | null
          status?: string
          upvote_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "claim_queue_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_queue_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      content_flags: {
        Row: {
          action_taken: string | null
          content_id: string
          content_type: Database["public"]["Enums"]["flag_content_type"]
          created_at: string
          id: string
          note: string | null
          reason: Database["public"]["Enums"]["flag_reason"]
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          user_id: string
        }
        Insert: {
          action_taken?: string | null
          content_id: string
          content_type: Database["public"]["Enums"]["flag_content_type"]
          created_at?: string
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["flag_reason"]
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          user_id: string
        }
        Update: {
          action_taken?: string | null
          content_id?: string
          content_type?: Database["public"]["Enums"]["flag_content_type"]
          created_at?: string
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["flag_reason"]
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_flags_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_flags_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      data_sync_log: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          estimated_mb: number | null
          id: string
          metadata: Json
          pipeline: string
          rows_failed: number
          rows_inserted: number
          rows_updated: number
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          estimated_mb?: number | null
          id?: string
          metadata?: Json
          pipeline: string
          rows_failed?: number
          rows_inserted?: number
          rows_updated?: number
          started_at?: string
          status: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          estimated_mb?: number | null
          id?: string
          metadata?: Json
          pipeline?: string
          rows_failed?: number
          rows_inserted?: number
          rows_updated?: number
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      edgar_companies: {
        Row: {
          canonical_name: string
          cik: string
          created_at: string
          financial_entity_id: string | null
          id: string
          metadata: Json
          name: string
          sector: string | null
          sic_code: string | null
          source_ids: Json
          state_of_inc: string | null
          ticker: string | null
          updated_at: string
        }
        Insert: {
          canonical_name: string
          cik: string
          created_at?: string
          financial_entity_id?: string | null
          id?: string
          metadata?: Json
          name: string
          sector?: string | null
          sic_code?: string | null
          source_ids?: Json
          state_of_inc?: string | null
          ticker?: string | null
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          cik?: string
          created_at?: string
          financial_entity_id?: string | null
          id?: string
          metadata?: Json
          name?: string
          sector?: string | null
          sic_code?: string | null
          source_ids?: Json
          state_of_inc?: string | null
          ticker?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "edgar_companies_financial_entity_id_fkey"
            columns: ["financial_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      edgar_executive_officers: {
        Row: {
          canonical_name: string
          company_id: string
          created_at: string
          effective_year: number
          financial_entity_id: string | null
          full_name: string
          id: string
          match_confidence: string | null
          metadata: Json
          role_category: string
          source_accession: string
          source_filing_type: string
          source_ids: Json
          title: string
          total_compensation_cents: number | null
          updated_at: string
        }
        Insert: {
          canonical_name: string
          company_id: string
          created_at?: string
          effective_year: number
          financial_entity_id?: string | null
          full_name: string
          id?: string
          match_confidence?: string | null
          metadata?: Json
          role_category: string
          source_accession: string
          source_filing_type: string
          source_ids?: Json
          title: string
          total_compensation_cents?: number | null
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          company_id?: string
          created_at?: string
          effective_year?: number
          financial_entity_id?: string | null
          full_name?: string
          id?: string
          match_confidence?: string | null
          metadata?: Json
          role_category?: string
          source_accession?: string
          source_filing_type?: string
          source_ids?: Json
          title?: string
          total_compensation_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "edgar_executive_officers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "edgar_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edgar_executive_officers_financial_entity_id_fkey"
            columns: ["financial_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      edgar_major_shareholders: {
        Row: {
          accession: string
          canonical_holder_name: string
          company_id: string
          created_at: string
          event_date: string | null
          filed_at: string
          filing_type: string
          financial_entity_id: string | null
          holder_name: string
          id: string
          match_confidence: string | null
          metadata: Json
          pct_of_class: number | null
          shares_held: number | null
          source_ids: Json
          updated_at: string
        }
        Insert: {
          accession: string
          canonical_holder_name: string
          company_id: string
          created_at?: string
          event_date?: string | null
          filed_at: string
          filing_type: string
          financial_entity_id?: string | null
          holder_name: string
          id?: string
          match_confidence?: string | null
          metadata?: Json
          pct_of_class?: number | null
          shares_held?: number | null
          source_ids?: Json
          updated_at?: string
        }
        Update: {
          accession?: string
          canonical_holder_name?: string
          company_id?: string
          created_at?: string
          event_date?: string | null
          filed_at?: string
          filing_type?: string
          financial_entity_id?: string | null
          holder_name?: string
          id?: string
          match_confidence?: string | null
          metadata?: Json
          pct_of_class?: number | null
          shares_held?: number | null
          source_ids?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "edgar_major_shareholders_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "edgar_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edgar_major_shareholders_financial_entity_id_fkey"
            columns: ["financial_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      enrichment_queue: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          context: Json | null
          created_at: string
          entity_id: string
          entity_type: string
          entity_updated_at: string
          id: number
          last_error: string | null
          priority: number
          result: Json | null
          retry_count: number
          status: string
          task_type: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          context?: Json | null
          created_at?: string
          entity_id: string
          entity_type: string
          entity_updated_at?: string
          id?: number
          last_error?: string | null
          priority?: number
          result?: Json | null
          retry_count?: number
          status?: string
          task_type: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          context?: Json | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          entity_updated_at?: string
          id?: number
          last_error?: string | null
          priority?: number
          result?: Json | null
          retry_count?: number
          status?: string
          task_type?: string
        }
        Relationships: []
      }
      entity_connections: {
        Row: {
          amount_cents: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          derived_at: string
          ended_at: string | null
          evidence_count: number
          evidence_ids: string[]
          evidence_source: string
          from_id: string
          from_type: string
          id: string
          metadata: Json
          occurred_at: string | null
          strength: number
          to_id: string
          to_type: string
        }
        Insert: {
          amount_cents?: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          derived_at?: string
          ended_at?: string | null
          evidence_count?: number
          evidence_ids?: string[]
          evidence_source: string
          from_id: string
          from_type: string
          id?: string
          metadata?: Json
          occurred_at?: string | null
          strength?: number
          to_id: string
          to_type: string
        }
        Update: {
          amount_cents?: number | null
          connection_type?: Database["public"]["Enums"]["connection_type"]
          derived_at?: string
          ended_at?: string | null
          evidence_count?: number
          evidence_ids?: string[]
          evidence_source?: string
          from_id?: string
          from_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string | null
          strength?: number
          to_id?: string
          to_type?: string
        }
        Relationships: []
      }
      entity_tags: {
        Row: {
          ai_model: string | null
          confidence: number | null
          created_at: string | null
          display_icon: string | null
          display_label: string
          entity_id: string
          entity_type: string
          generated_by: string
          id: string
          metadata: Json | null
          pipeline_version: string | null
          tag: string
          tag_category: string
          visibility: string
        }
        Insert: {
          ai_model?: string | null
          confidence?: number | null
          created_at?: string | null
          display_icon?: string | null
          display_label: string
          entity_id: string
          entity_type: string
          generated_by: string
          id?: string
          metadata?: Json | null
          pipeline_version?: string | null
          tag: string
          tag_category: string
          visibility?: string
        }
        Update: {
          ai_model?: string | null
          confidence?: number | null
          created_at?: string | null
          display_icon?: string | null
          display_label?: string
          entity_id?: string
          entity_type?: string
          generated_by?: string
          id?: string
          metadata?: Json | null
          pipeline_version?: string | null
          tag?: string
          tag_category?: string
          visibility?: string
        }
        Relationships: []
      }
      external_relationships: {
        Row: {
          amount_cents: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          description: string | null
          ended_at: string | null
          from_id: string
          from_type: string
          id: string
          ingested_at: string
          is_current: boolean | null
          match_confidence: string
          metadata: Json
          occurred_at: string | null
          raw_category: string
          raw_category_name: string | null
          source: string
          source_id: string
          source_updated_at: string | null
          source_url: string | null
          to_id: string
          to_type: string
        }
        Insert: {
          amount_cents?: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          description?: string | null
          ended_at?: string | null
          from_id: string
          from_type: string
          id?: string
          ingested_at?: string
          is_current?: boolean | null
          match_confidence: string
          metadata?: Json
          occurred_at?: string | null
          raw_category: string
          raw_category_name?: string | null
          source: string
          source_id: string
          source_updated_at?: string | null
          source_url?: string | null
          to_id: string
          to_type: string
        }
        Update: {
          amount_cents?: number | null
          connection_type?: Database["public"]["Enums"]["connection_type"]
          description?: string | null
          ended_at?: string | null
          from_id?: string
          from_type?: string
          id?: string
          ingested_at?: string
          is_current?: boolean | null
          match_confidence?: string
          metadata?: Json
          occurred_at?: string | null
          raw_category?: string
          raw_category_name?: string | null
          source?: string
          source_id?: string
          source_updated_at?: string | null
          source_url?: string | null
          to_id?: string
          to_type?: string
        }
        Relationships: []
      }
      external_relationships_review_queue: {
        Row: {
          candidate_matches: Json
          created_at: string
          id: string
          reason: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_to_id: string | null
          resolved_to_type: string | null
          source: string
          source_entity_id: string | null
          source_payload: Json
          source_relationship_id: string | null
          status: string
        }
        Insert: {
          candidate_matches: Json
          created_at?: string
          id?: string
          reason: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_to_id?: string | null
          resolved_to_type?: string | null
          source: string
          source_entity_id?: string | null
          source_payload: Json
          source_relationship_id?: string | null
          status?: string
        }
        Update: {
          candidate_matches?: Json
          created_at?: string
          id?: string
          reason?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_to_id?: string | null
          resolved_to_type?: string | null
          source?: string
          source_entity_id?: string | null
          source_payload?: Json
          source_relationship_id?: string | null
          status?: string
        }
        Relationships: []
      }
      external_source_refs: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          external_id: string
          id: string
          last_seen_at: string
          metadata: Json
          source: string
          source_url: string | null
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          external_id: string
          id?: string
          last_seen_at?: string
          metadata?: Json
          source: string
          source_url?: string | null
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          external_id?: string
          id?: string
          last_seen_at?: string
          metadata?: Json
          source?: string
          source_url?: string | null
        }
        Relationships: []
      }
      financial_entities: {
        Row: {
          canonical_name: string
          created_at: string
          display_name: string
          donor_fingerprint: string | null
          entity_type: string
          fec_committee_id: string | null
          id: string
          metadata: Json
          parent_entity_id: string | null
          recipient_count: number
          total_contract_cents: number
          total_donated_cents: number
          total_grant_cents: number
          total_received_cents: number
          updated_at: string
        }
        Insert: {
          canonical_name: string
          created_at?: string
          display_name: string
          donor_fingerprint?: string | null
          entity_type: string
          fec_committee_id?: string | null
          id?: string
          metadata?: Json
          parent_entity_id?: string | null
          recipient_count?: number
          total_contract_cents?: number
          total_donated_cents?: number
          total_grant_cents?: number
          total_received_cents?: number
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          created_at?: string
          display_name?: string
          donor_fingerprint?: string | null
          entity_type?: string
          fec_committee_id?: string | null
          id?: string
          metadata?: Json
          parent_entity_id?: string | null
          recipient_count?: number
          total_contract_cents?: number
          total_donated_cents?: number
          total_grant_cents?: number
          total_received_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_entities_parent_entity_id_fkey"
            columns: ["parent_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_relationships: {
        Row: {
          amount_cents: number | null
          created_at: string
          cycle_year: number | null
          disclosure_form_id: string | null
          ended_at: string | null
          fec_filing_id: string | null
          from_id: string
          from_type: string
          id: string
          is_bundled: boolean
          is_in_kind: boolean
          metadata: Json
          occurred_at: string | null
          relationship_type: Database["public"]["Enums"]["financial_relationship_type"]
          source_url: string | null
          started_at: string | null
          to_id: string
          to_type: string
          updated_at: string
          usaspending_award_id: string | null
        }
        Insert: {
          amount_cents?: number | null
          created_at?: string
          cycle_year?: number | null
          disclosure_form_id?: string | null
          ended_at?: string | null
          fec_filing_id?: string | null
          from_id: string
          from_type: string
          id?: string
          is_bundled?: boolean
          is_in_kind?: boolean
          metadata?: Json
          occurred_at?: string | null
          relationship_type: Database["public"]["Enums"]["financial_relationship_type"]
          source_url?: string | null
          started_at?: string | null
          to_id: string
          to_type: string
          updated_at?: string
          usaspending_award_id?: string | null
        }
        Update: {
          amount_cents?: number | null
          created_at?: string
          cycle_year?: number | null
          disclosure_form_id?: string | null
          ended_at?: string | null
          fec_filing_id?: string | null
          from_id?: string
          from_type?: string
          id?: string
          is_bundled?: boolean
          is_in_kind?: boolean
          metadata?: Json
          occurred_at?: string | null
          relationship_type?: Database["public"]["Enums"]["financial_relationship_type"]
          source_url?: string | null
          started_at?: string | null
          to_id?: string
          to_type?: string
          updated_at?: string
          usaspending_award_id?: string | null
        }
        Relationships: []
      }
      governing_bodies: {
        Row: {
          contact_email: string | null
          created_at: string
          id: string
          is_active: boolean
          jurisdiction_id: string
          metadata: Json
          name: string
          seat_count: number | null
          short_name: string | null
          term_length_years: number | null
          type: Database["public"]["Enums"]["governing_body_type"]
          updated_at: string
          website_url: string | null
        }
        Insert: {
          contact_email?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          jurisdiction_id: string
          metadata?: Json
          name: string
          seat_count?: number | null
          short_name?: string | null
          term_length_years?: number | null
          type: Database["public"]["Enums"]["governing_body_type"]
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          contact_email?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          jurisdiction_id?: string
          metadata?: Json
          name?: string
          seat_count?: number | null
          short_name?: string | null
          term_length_years?: number | null
          type?: Database["public"]["Enums"]["governing_body_type"]
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "governing_bodies_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      graph_snapshots: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          id: string
          is_public: boolean
          state: Json
          title: string | null
          view_count: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_public?: boolean
          state: Json
          title?: string | null
          view_count?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_public?: boolean
          state?: Json
          title?: string | null
          view_count?: number
        }
        Relationships: []
      }
      industry_codes: {
        Row: {
          code: string
          label: string
          sector: string | null
          source: string
        }
        Insert: {
          code: string
          label: string
          sector?: string | null
          source?: string
        }
        Update: {
          code?: string
          label?: string
          sector?: string | null
          source?: string
        }
        Relationships: []
      }
      initiative_details: {
        Row: {
          authorship_type: Database["public"]["Enums"]["initiative_authorship"]
          body_md: string
          issue_area_tags: string[]
          mobilise_started_at: string | null
          primary_author_id: string | null
          promoted_to_proposal_id: string | null
          proposal_id: string
          quality_gate_score: Json
          resolution_type:
            | Database["public"]["Enums"]["initiative_resolution"]
            | null
          scope: Database["public"]["Enums"]["initiative_scope"]
          signature_threshold: number | null
          stage: Database["public"]["Enums"]["initiative_stage"]
          target_district: string | null
        }
        Insert: {
          authorship_type?: Database["public"]["Enums"]["initiative_authorship"]
          body_md: string
          issue_area_tags?: string[]
          mobilise_started_at?: string | null
          primary_author_id?: string | null
          promoted_to_proposal_id?: string | null
          proposal_id: string
          quality_gate_score?: Json
          resolution_type?:
            | Database["public"]["Enums"]["initiative_resolution"]
            | null
          scope?: Database["public"]["Enums"]["initiative_scope"]
          signature_threshold?: number | null
          stage?: Database["public"]["Enums"]["initiative_stage"]
          target_district?: string | null
        }
        Update: {
          authorship_type?: Database["public"]["Enums"]["initiative_authorship"]
          body_md?: string
          issue_area_tags?: string[]
          mobilise_started_at?: string | null
          primary_author_id?: string | null
          promoted_to_proposal_id?: string | null
          proposal_id?: string
          quality_gate_score?: Json
          resolution_type?:
            | Database["public"]["Enums"]["initiative_resolution"]
            | null
          scope?: Database["public"]["Enums"]["initiative_scope"]
          signature_threshold?: number | null
          stage?: Database["public"]["Enums"]["initiative_stage"]
          target_district?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "initiative_details_primary_author_id_fkey"
            columns: ["primary_author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "initiative_details_promoted_to_proposal_id_fkey"
            columns: ["promoted_to_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "initiative_details_promoted_to_proposal_id_fkey"
            columns: ["promoted_to_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "initiative_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "initiative_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      irs990_filings: {
        Row: {
          address_state: string | null
          created_at: string
          ein: string
          fetched_at: string
          filing_type: string
          financial_entity_id: string
          id: string
          metadata: Json
          ntee_code: string | null
          object_id: string
          schema_version: string | null
          source_url: string
          subsection_code: number | null
          tax_year: number
          total_assets_eoy_cents: number | null
          total_expenses_cents: number | null
          total_revenue_cents: number | null
          updated_at: string
        }
        Insert: {
          address_state?: string | null
          created_at?: string
          ein: string
          fetched_at?: string
          filing_type: string
          financial_entity_id: string
          id?: string
          metadata?: Json
          ntee_code?: string | null
          object_id: string
          schema_version?: string | null
          source_url: string
          subsection_code?: number | null
          tax_year: number
          total_assets_eoy_cents?: number | null
          total_expenses_cents?: number | null
          total_revenue_cents?: number | null
          updated_at?: string
        }
        Update: {
          address_state?: string | null
          created_at?: string
          ein?: string
          fetched_at?: string
          filing_type?: string
          financial_entity_id?: string
          id?: string
          metadata?: Json
          ntee_code?: string | null
          object_id?: string
          schema_version?: string | null
          source_url?: string
          subsection_code?: number | null
          tax_year?: number
          total_assets_eoy_cents?: number | null
          total_expenses_cents?: number | null
          total_revenue_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "irs990_filings_financial_entity_id_fkey"
            columns: ["financial_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      irs990_grants_out: {
        Row: {
          amount_cents: number
          filing_id: string
          id: string
          matched_entity_id: string | null
          matched_entity_type: string | null
          metadata: Json
          purpose: string | null
          recipient_ein: string | null
          recipient_name: string
          recipient_name_canonical: string
        }
        Insert: {
          amount_cents: number
          filing_id: string
          id?: string
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          metadata?: Json
          purpose?: string | null
          recipient_ein?: string | null
          recipient_name: string
          recipient_name_canonical: string
        }
        Update: {
          amount_cents?: number
          filing_id?: string
          id?: string
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          metadata?: Json
          purpose?: string | null
          recipient_ein?: string | null
          recipient_name?: string
          recipient_name_canonical?: string
        }
        Relationships: [
          {
            foreignKeyName: "irs990_grants_out_filing_id_fkey"
            columns: ["filing_id"]
            isOneToOne: false
            referencedRelation: "irs990_filings"
            referencedColumns: ["id"]
          },
        ]
      }
      irs990_officers: {
        Row: {
          compensation_cents: number | null
          filing_id: string
          hours_per_week: number | null
          id: string
          match_confidence: number | null
          matched_entity_id: string | null
          matched_entity_type: string | null
          metadata: Json
          name_canonical: string
          person_name: string
          role_title: string
        }
        Insert: {
          compensation_cents?: number | null
          filing_id: string
          hours_per_week?: number | null
          id?: string
          match_confidence?: number | null
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          metadata?: Json
          name_canonical: string
          person_name: string
          role_title: string
        }
        Update: {
          compensation_cents?: number | null
          filing_id?: string
          hours_per_week?: number | null
          id?: string
          match_confidence?: number | null
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          metadata?: Json
          name_canonical?: string
          person_name?: string
          role_title?: string
        }
        Relationships: [
          {
            foreignKeyName: "irs990_officers_filing_id_fkey"
            columns: ["filing_id"]
            isOneToOne: false
            referencedRelation: "irs990_filings"
            referencedColumns: ["id"]
          },
        ]
      }
      jurisdictions: {
        Row: {
          boundary_geometry: unknown
          census_geoid: string | null
          centroid: unknown
          country_code: string | null
          coverage_completed_at: string | null
          coverage_started_at: string | null
          coverage_status: string
          created_at: string
          fips_code: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          parent_id: string | null
          population: number | null
          short_name: string | null
          timezone: string | null
          type: Database["public"]["Enums"]["jurisdiction_type"]
          updated_at: string
        }
        Insert: {
          boundary_geometry?: unknown
          census_geoid?: string | null
          centroid?: unknown
          country_code?: string | null
          coverage_completed_at?: string | null
          coverage_started_at?: string | null
          coverage_status?: string
          created_at?: string
          fips_code?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          parent_id?: string | null
          population?: number | null
          short_name?: string | null
          timezone?: string | null
          type: Database["public"]["Enums"]["jurisdiction_type"]
          updated_at?: string
        }
        Update: {
          boundary_geometry?: unknown
          census_geoid?: string | null
          centroid?: unknown
          country_code?: string | null
          coverage_completed_at?: string | null
          coverage_started_at?: string | null
          coverage_status?: string
          created_at?: string
          fips_code?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          parent_id?: string | null
          population?: number | null
          short_name?: string | null
          timezone?: string | null
          type?: Database["public"]["Enums"]["jurisdiction_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jurisdictions_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      lobbying_disclosures: {
        Row: {
          amount_cents: number | null
          client_name: string
          created_at: string
          filing_period: string | null
          filing_year: number
          id: string
          industry_code: string | null
          metadata: Json
          official_id: string | null
          registrant_name: string
          source: string
          source_url: string | null
        }
        Insert: {
          amount_cents?: number | null
          client_name: string
          created_at?: string
          filing_period?: string | null
          filing_year: number
          id?: string
          industry_code?: string | null
          metadata?: Json
          official_id?: string | null
          registrant_name: string
          source?: string
          source_url?: string | null
        }
        Update: {
          amount_cents?: number | null
          client_name?: string
          created_at?: string
          filing_period?: string | null
          filing_year?: number
          id?: string
          industry_code?: string | null
          metadata?: Json
          official_id?: string | null
          registrant_name?: string
          source?: string
          source_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lobbying_disclosures_industry_code_fkey"
            columns: ["industry_code"]
            isOneToOne: false
            referencedRelation: "industry_codes"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "lobbying_disclosures_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "lobbying_disclosures_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      measure_details: {
        Row: {
          ballot_id: string
          ballotpedia_url: string | null
          election_date: string
          election_type: string | null
          measure_type: string | null
          no_votes: number | null
          originating_initiative_id: string | null
          passed: boolean | null
          percent_yes: number | null
          proposal_id: string
          text_summary: string | null
          yes_votes: number | null
        }
        Insert: {
          ballot_id: string
          ballotpedia_url?: string | null
          election_date: string
          election_type?: string | null
          measure_type?: string | null
          no_votes?: number | null
          originating_initiative_id?: string | null
          passed?: boolean | null
          percent_yes?: number | null
          proposal_id: string
          text_summary?: string | null
          yes_votes?: number | null
        }
        Update: {
          ballot_id?: string
          ballotpedia_url?: string | null
          election_date?: string
          election_type?: string | null
          measure_type?: string | null
          no_votes?: number | null
          originating_initiative_id?: string | null
          passed?: boolean | null
          percent_yes?: number | null
          proposal_id?: string
          text_summary?: string | null
          yes_votes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "measure_details_originating_initiative_id_fkey"
            columns: ["originating_initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "measure_details_originating_initiative_id_fkey"
            columns: ["originating_initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "measure_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "measure_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          agenda_url: string | null
          created_at: string
          governing_body_id: string
          id: string
          location: string | null
          meeting_type: string
          metadata: Json
          minutes_url: string | null
          scheduled_at: string
          status: string
          title: string | null
          updated_at: string
          video_url: string | null
        }
        Insert: {
          agenda_url?: string | null
          created_at?: string
          governing_body_id: string
          id?: string
          location?: string | null
          meeting_type: string
          metadata?: Json
          minutes_url?: string | null
          scheduled_at: string
          status?: string
          title?: string | null
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          agenda_url?: string | null
          created_at?: string
          governing_body_id?: string
          id?: string
          location?: string | null
          meeting_type?: string
          metadata?: Json
          minutes_url?: string | null
          scheduled_at?: string
          status?: string
          title?: string | null
          updated_at?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meetings_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          email_sent: boolean
          entity_id: string | null
          entity_type: Database["public"]["Enums"]["follow_entity_type"] | null
          event_type: Database["public"]["Enums"]["notification_event_type"]
          id: string
          is_read: boolean
          link: string | null
          title: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          email_sent?: boolean
          entity_id?: string | null
          entity_type?: Database["public"]["Enums"]["follow_entity_type"] | null
          event_type: Database["public"]["Enums"]["notification_event_type"]
          id?: string
          is_read?: boolean
          link?: string | null
          title: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          email_sent?: boolean
          entity_id?: string | null
          entity_type?: Database["public"]["Enums"]["follow_entity_type"] | null
          event_type?: Database["public"]["Enums"]["notification_event_type"]
          id?: string
          is_read?: boolean
          link?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      official_comment_submissions: {
        Row: {
          ai_assisted: boolean
          arweave_tx: string | null
          comment_text: string
          confirmation_number: string | null
          created_at: string
          id: string
          metadata: Json
          proposal_id: string
          regulations_gov_id: string | null
          submission_status: string
          submitted_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_assisted?: boolean
          arweave_tx?: string | null
          comment_text: string
          confirmation_number?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          proposal_id: string
          regulations_gov_id?: string | null
          submission_status?: string
          submitted_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_assisted?: boolean
          arweave_tx?: string | null
          comment_text?: string
          confirmation_number?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          proposal_id?: string
          regulations_gov_id?: string | null
          submission_status?: string
          submitted_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "official_comment_submissions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "official_comment_submissions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      official_committee_memberships: {
        Row: {
          committee_id: string
          created_at: string
          ended_at: string | null
          id: string
          metadata: Json
          official_id: string
          role: string
          started_at: string | null
          updated_at: string
        }
        Insert: {
          committee_id: string
          created_at?: string
          ended_at?: string | null
          id?: string
          metadata?: Json
          official_id: string
          role?: string
          started_at?: string | null
          updated_at?: string
        }
        Update: {
          committee_id?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          metadata?: Json
          official_id?: string
          role?: string
          started_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "official_committee_memberships_committee_id_fkey"
            columns: ["committee_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "official_committee_memberships_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "official_committee_memberships_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      official_community_comments: {
        Row: {
          body: string
          created_at: string
          id: string
          is_deleted: boolean
          metadata: Json
          official_id: string
          updated_at: string
          upvotes: number
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          is_deleted?: boolean
          metadata?: Json
          official_id: string
          updated_at?: string
          upvotes?: number
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_deleted?: boolean
          metadata?: Json
          official_id?: string
          updated_at?: string
          upvotes?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "official_community_comments_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "official_community_comments_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "official_community_comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      officials: {
        Row: {
          created_at: string
          current_term_end: string | null
          current_term_start: string | null
          district_name: string | null
          email: string | null
          first_name: string | null
          full_name: string
          governing_body_id: string | null
          id: string
          is_active: boolean
          is_up_for_election: boolean
          is_verified: boolean
          jurisdiction_id: string
          last_name: string | null
          metadata: Json
          next_election_date: string | null
          next_election_type: string | null
          office_address: string | null
          party: Database["public"]["Enums"]["party"] | null
          phone: string | null
          photo_url: string | null
          role_title: string
          source_ids: Json
          term_end: string | null
          term_start: string | null
          tier: string
          total_received_cents: number
          updated_at: string
          website_url: string | null
        }
        Insert: {
          created_at?: string
          current_term_end?: string | null
          current_term_start?: string | null
          district_name?: string | null
          email?: string | null
          first_name?: string | null
          full_name: string
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          is_up_for_election?: boolean
          is_verified?: boolean
          jurisdiction_id: string
          last_name?: string | null
          metadata?: Json
          next_election_date?: string | null
          next_election_type?: string | null
          office_address?: string | null
          party?: Database["public"]["Enums"]["party"] | null
          phone?: string | null
          photo_url?: string | null
          role_title: string
          source_ids?: Json
          term_end?: string | null
          term_start?: string | null
          tier?: string
          total_received_cents?: number
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          created_at?: string
          current_term_end?: string | null
          current_term_start?: string | null
          district_name?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          is_up_for_election?: boolean
          is_verified?: boolean
          jurisdiction_id?: string
          last_name?: string | null
          metadata?: Json
          next_election_date?: string | null
          next_election_type?: string | null
          office_address?: string | null
          party?: Database["public"]["Enums"]["party"] | null
          phone?: string | null
          photo_url?: string | null
          role_title?: string
          source_ids?: Json
          term_end?: string | null
          term_start?: string | null
          tier?: string
          total_received_cents?: number
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "officials_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officials_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      page_views: {
        Row: {
          bot_name: string | null
          browser: string | null
          country_code: string | null
          device_type: string | null
          entity_id: string | null
          entity_type: string | null
          id: string
          is_bot: boolean | null
          page: string
          referrer: string | null
          session_id: string | null
          viewed_at: string | null
        }
        Insert: {
          bot_name?: string | null
          browser?: string | null
          country_code?: string | null
          device_type?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          is_bot?: boolean | null
          page: string
          referrer?: string | null
          session_id?: string | null
          viewed_at?: string | null
        }
        Update: {
          bot_name?: string | null
          browser?: string | null
          country_code?: string | null
          device_type?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          is_bot?: boolean | null
          page?: string
          referrer?: string | null
          session_id?: string | null
          viewed_at?: string | null
        }
        Relationships: []
      }
      pipeline_cost_history: {
        Row: {
          actual_cost_usd: number | null
          actual_tokens_input: number | null
          actual_tokens_output: number | null
          entity_count: number
          estimated_cost_usd: number
          estimated_tokens_input: number | null
          estimated_tokens_output: number | null
          id: string
          metadata: Json | null
          notes: string | null
          paused_for_variance: boolean | null
          pipeline_name: string
          run_at: string | null
          sample_size: number | null
          status: string | null
          variance_ratio: number | null
          was_auto_approved: boolean | null
        }
        Insert: {
          actual_cost_usd?: number | null
          actual_tokens_input?: number | null
          actual_tokens_output?: number | null
          entity_count: number
          estimated_cost_usd: number
          estimated_tokens_input?: number | null
          estimated_tokens_output?: number | null
          id?: string
          metadata?: Json | null
          notes?: string | null
          paused_for_variance?: boolean | null
          pipeline_name: string
          run_at?: string | null
          sample_size?: number | null
          status?: string | null
          variance_ratio?: number | null
          was_auto_approved?: boolean | null
        }
        Update: {
          actual_cost_usd?: number | null
          actual_tokens_input?: number | null
          actual_tokens_output?: number | null
          entity_count?: number
          estimated_cost_usd?: number
          estimated_tokens_input?: number | null
          estimated_tokens_output?: number | null
          id?: string
          metadata?: Json | null
          notes?: string | null
          paused_for_variance?: boolean | null
          pipeline_name?: string
          run_at?: string | null
          sample_size?: number | null
          status?: string | null
          variance_ratio?: number | null
          was_auto_approved?: boolean | null
        }
        Relationships: []
      }
      pipeline_state: {
        Row: {
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string | null
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      platform_limits: {
        Row: {
          billing_cycle: string | null
          critical_pct: number | null
          display_group: string | null
          display_label: string | null
          has_public_api: boolean
          id: string
          included_limit: number
          is_active: boolean | null
          metric: string
          notes: string | null
          overage_cap: number | null
          overage_unit: string | null
          overage_unit_cost: number | null
          plan: string
          service: string
          sort_order: number | null
          unit: string
          updated_at: string | null
          warning_pct: number | null
        }
        Insert: {
          billing_cycle?: string | null
          critical_pct?: number | null
          display_group?: string | null
          display_label?: string | null
          has_public_api?: boolean
          id?: string
          included_limit: number
          is_active?: boolean | null
          metric: string
          notes?: string | null
          overage_cap?: number | null
          overage_unit?: string | null
          overage_unit_cost?: number | null
          plan?: string
          service: string
          sort_order?: number | null
          unit: string
          updated_at?: string | null
          warning_pct?: number | null
        }
        Update: {
          billing_cycle?: string | null
          critical_pct?: number | null
          display_group?: string | null
          display_label?: string | null
          has_public_api?: boolean
          id?: string
          included_limit?: number
          is_active?: boolean | null
          metric?: string
          notes?: string | null
          overage_cap?: number | null
          overage_unit?: string | null
          overage_unit_cost?: number | null
          plan?: string
          service?: string
          sort_order?: number | null
          unit?: string
          updated_at?: string | null
          warning_pct?: number | null
        }
        Relationships: []
      }
      platform_usage: {
        Row: {
          id: string
          metric: string
          period_end: string | null
          period_start: string | null
          recorded_at: string | null
          service: string
          source: string
          stale_after_days: number | null
          value: number
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          id?: string
          metric: string
          period_end?: string | null
          period_start?: string | null
          recorded_at?: string | null
          service: string
          source?: string
          stale_after_days?: number | null
          value: number
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          id?: string
          metric?: string
          period_end?: string | null
          period_start?: string | null
          recorded_at?: string | null
          service?: string
          source?: string
          stale_after_days?: number | null
          value?: number
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      promises: {
        Row: {
          arweave_tx: string | null
          created_at: string
          deadline: string | null
          description: string | null
          id: string
          jurisdiction_id: string
          made_at: string | null
          metadata: Json
          official_id: string
          onchain_tx_hash: string | null
          related_proposal_id: string | null
          resolved_at: string | null
          source_quote: string | null
          source_url: string | null
          status: Database["public"]["Enums"]["promise_status"]
          title: string
          updated_at: string
        }
        Insert: {
          arweave_tx?: string | null
          created_at?: string
          deadline?: string | null
          description?: string | null
          id?: string
          jurisdiction_id: string
          made_at?: string | null
          metadata?: Json
          official_id: string
          onchain_tx_hash?: string | null
          related_proposal_id?: string | null
          resolved_at?: string | null
          source_quote?: string | null
          source_url?: string | null
          status?: Database["public"]["Enums"]["promise_status"]
          title: string
          updated_at?: string
        }
        Update: {
          arweave_tx?: string | null
          created_at?: string
          deadline?: string | null
          description?: string | null
          id?: string
          jurisdiction_id?: string
          made_at?: string | null
          metadata?: Json
          official_id?: string
          onchain_tx_hash?: string | null
          related_proposal_id?: string | null
          resolved_at?: string | null
          source_quote?: string | null
          source_url?: string | null
          status?: Database["public"]["Enums"]["promise_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promises_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promises_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "promises_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promises_related_proposal_id_fkey"
            columns: ["related_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "promises_related_proposal_id_fkey"
            columns: ["related_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      proposal_actions: {
        Row: {
          action_at: string
          action_type: string
          created_at: string
          description: string | null
          id: string
          metadata: Json
          performed_by_id: string | null
          proposal_id: string
          source: string | null
        }
        Insert: {
          action_at: string
          action_type: string
          created_at?: string
          description?: string | null
          id?: string
          metadata?: Json
          performed_by_id?: string | null
          proposal_id: string
          source?: string | null
        }
        Update: {
          action_at?: string
          action_type?: string
          created_at?: string
          description?: string | null
          id?: string
          metadata?: Json
          performed_by_id?: string | null
          proposal_id?: string
          source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "proposal_actions_performed_by_id_fkey"
            columns: ["performed_by_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "proposal_actions_performed_by_id_fkey"
            columns: ["performed_by_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_actions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "proposal_actions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      proposal_cosponsors: {
        Row: {
          created_at: string
          date_added: string | null
          date_withdrawn: string | null
          id: string
          is_original_cosponsor: boolean
          official_id: string
          proposal_id: string
          source: string
        }
        Insert: {
          created_at?: string
          date_added?: string | null
          date_withdrawn?: string | null
          id?: string
          is_original_cosponsor?: boolean
          official_id: string
          proposal_id: string
          source?: string
        }
        Update: {
          created_at?: string
          date_added?: string | null
          date_withdrawn?: string | null
          id?: string
          is_original_cosponsor?: boolean
          official_id?: string
          proposal_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposal_cosponsors_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "proposal_cosponsors_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_cosponsors_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "proposal_cosponsors_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      proposals: {
        Row: {
          created_at: string
          external_url: string | null
          full_text_r2_key: string | null
          full_text_url: string | null
          governing_body_id: string | null
          id: string
          introduced_at: string | null
          jurisdiction_id: string
          last_action_at: string | null
          metadata: Json
          resolved_at: string | null
          search_vector: unknown
          short_title: string | null
          status: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at: string | null
          summary_model: string | null
          summary_plain: string | null
          title: string
          type: Database["public"]["Enums"]["proposal_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          external_url?: string | null
          full_text_r2_key?: string | null
          full_text_url?: string | null
          governing_body_id?: string | null
          id?: string
          introduced_at?: string | null
          jurisdiction_id: string
          last_action_at?: string | null
          metadata?: Json
          resolved_at?: string | null
          search_vector?: unknown
          short_title?: string | null
          status?: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at?: string | null
          summary_model?: string | null
          summary_plain?: string | null
          title: string
          type: Database["public"]["Enums"]["proposal_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          external_url?: string | null
          full_text_r2_key?: string | null
          full_text_url?: string | null
          governing_body_id?: string | null
          id?: string
          introduced_at?: string | null
          jurisdiction_id?: string
          last_action_at?: string | null
          metadata?: Json
          resolved_at?: string | null
          search_vector?: unknown
          short_title?: string | null
          status?: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at?: string | null
          summary_model?: string | null
          summary_plain?: string | null
          title?: string
          type?: Database["public"]["Enums"]["proposal_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposals_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      service_usage: {
        Row: {
          count: number
          created_at: string
          id: string
          metadata: Json
          metric: string
          period: string
          service: string
        }
        Insert: {
          count?: number
          created_at?: string
          id?: string
          metadata?: Json
          metric: string
          period: string
          service: string
        }
        Update: {
          count?: number
          created_at?: string
          id?: string
          metadata?: Json
          metric?: string
          period?: string
          service?: string
        }
        Relationships: []
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      user_custom_groups: {
        Row: {
          color: string | null
          created_at: string
          filter: Json
          icon: string | null
          id: string
          is_public: boolean
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          filter: Json
          icon?: string | null
          id?: string
          is_public?: boolean
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          filter?: Json
          icon?: string | null
          id?: string
          is_public?: boolean
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_custom_groups_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_follows: {
        Row: {
          created_at: string
          email_enabled: boolean
          entity_id: string
          entity_type: Database["public"]["Enums"]["follow_entity_type"]
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_enabled?: boolean
          entity_id: string
          entity_type: Database["public"]["Enums"]["follow_entity_type"]
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_enabled?: boolean
          entity_id?: string
          entity_type?: Database["public"]["Enums"]["follow_entity_type"]
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_follows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          created_at: string
          followed_agencies: string[]
          followed_officials: string[]
          followed_proposals: string[]
          graph_root_hint: string | null
          home_district: number | null
          home_jurisdiction_id: string | null
          home_state: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          followed_agencies?: string[]
          followed_officials?: string[]
          followed_proposals?: string[]
          graph_root_hint?: string | null
          home_district?: number | null
          home_jurisdiction_id?: string | null
          home_state?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          followed_agencies?: string[]
          followed_officials?: string[]
          followed_proposals?: string[]
          graph_root_hint?: string | null
          home_district?: number | null
          home_jurisdiction_id?: string | null
          home_state?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_home_jurisdiction_id_fkey"
            columns: ["home_jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          auth_provider: string | null
          avatar_url: string | null
          civic_credits_balance: number | null
          created_at: string | null
          display_name: string | null
          email: string | null
          id: string
          is_active: boolean | null
          last_seen: string | null
          metadata: Json | null
          updated_at: string | null
        }
        Insert: {
          auth_provider?: string | null
          avatar_url?: string | null
          civic_credits_balance?: number | null
          created_at?: string | null
          display_name?: string | null
          email?: string | null
          id: string
          is_active?: boolean | null
          last_seen?: string | null
          metadata?: Json | null
          updated_at?: string | null
        }
        Update: {
          auth_provider?: string | null
          avatar_url?: string | null
          civic_credits_balance?: number | null
          created_at?: string | null
          display_name?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          last_seen?: string | null
          metadata?: Json | null
          updated_at?: string | null
        }
        Relationships: []
      }
      votes: {
        Row: {
          agenda_item_id: string | null
          bill_proposal_id: string
          chamber: string
          created_at: string
          id: string
          metadata: Json
          official_id: string
          roll_call_id: string
          session: string | null
          source_url: string | null
          updated_at: string
          vote: string
          vote_question: string | null
          voted_at: string
        }
        Insert: {
          agenda_item_id?: string | null
          bill_proposal_id: string
          chamber: string
          created_at?: string
          id?: string
          metadata?: Json
          official_id: string
          roll_call_id: string
          session?: string | null
          source_url?: string | null
          updated_at?: string
          vote: string
          vote_question?: string | null
          voted_at: string
        }
        Update: {
          agenda_item_id?: string | null
          bill_proposal_id?: string
          chamber?: string
          created_at?: string
          id?: string
          metadata?: Json
          official_id?: string
          roll_call_id?: string
          session?: string | null
          source_url?: string | null
          updated_at?: string
          vote?: string
          vote_question?: string | null
          voted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "votes_agenda_item_id_fkey"
            columns: ["agenda_item_id"]
            isOneToOne: false
            referencedRelation: "agenda_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "votes_bill_proposal_id_fkey"
            columns: ["bill_proposal_id"]
            isOneToOne: false
            referencedRelation: "bill_details"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "votes_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "votes_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      warrant_canary: {
        Row: {
          block_number: number | null
          chain: string
          created_at: string
          id: string
          onchain_tx_hash: string | null
          published_at: string
          signature: string | null
          statement_text: string
        }
        Insert: {
          block_number?: number | null
          chain?: string
          created_at?: string
          id?: string
          onchain_tx_hash?: string | null
          published_at: string
          signature?: string | null
          statement_text: string
        }
        Update: {
          block_number?: number | null
          chain?: string
          created_at?: string
          id?: string
          onchain_tx_hash?: string | null
          published_at?: string
          signature?: string | null
          statement_text?: string
        }
        Relationships: []
      }
      web_vitals_samples: {
        Row: {
          exceeded: boolean
          id: string
          metric: string
          path: string | null
          rating: string | null
          recorded_at: string
          user_agent: string | null
          value: number
        }
        Insert: {
          exceeded?: boolean
          id?: string
          metric: string
          path?: string | null
          rating?: string | null
          recorded_at?: string
          user_agent?: string | null
          value: number
        }
        Update: {
          exceeded?: boolean
          id?: string
          metric?: string
          path?: string | null
          rating?: string | null
          recorded_at?: string
          user_agent?: string | null
          value?: number
        }
        Relationships: []
      }
    }
    Views: {
      chord_donor_state_party_flows_mv: {
        Row: {
          donor_state: string | null
          party_chamber: string | null
          total_usd: number | null
        }
        Relationships: []
      }
      chord_donor_type_party_flows_mv: {
        Row: {
          donor_type: string | null
          party_chamber: string | null
          total_usd: number | null
        }
        Relationships: []
      }
      chord_industry_flows_mv: {
        Row: {
          display_icon: string | null
          display_label: string | null
          donor_count: number | null
          industry: string | null
          official_count: number | null
          party_chamber: string | null
          total_cents: number | null
        }
        Relationships: []
      }
      chord_subject_party_flows_mv: {
        Row: {
          display_icon: string | null
          display_label: string | null
          party_chamber: string | null
          subject: string | null
          vote_count: number | null
        }
        Relationships: []
      }
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
      homepage_stats_mv: {
        Row: {
          active_proposals_count: number | null
          donor_records_count: number | null
          officials_count: number | null
          refreshed_at: string | null
          spending_records_count: number | null
        }
        Relationships: []
      }
      official_homepage_stats_mv: {
        Row: {
          donor_count: number | null
          financial_relationship_count: number | null
          official_id: string | null
          refreshed_at: string | null
          total_donations_cents: number | null
          vote_count: number | null
        }
        Relationships: []
      }
      pipeline_runtime_stats_mv: {
        Row: {
          last_run_at: string | null
          max_duration_ms: number | null
          max_peak_rss_mb: number | null
          p50_duration_ms: number | null
          p95_duration_ms: number | null
          p95_peak_rss_mb: number | null
          pipeline: string | null
          runs_30d: number | null
          success_rate_pct: number | null
          successful_runs_30d: number | null
        }
        Relationships: []
      }
      proposal_comment_stats: {
        Row: {
          comment_count: number | null
          comments_24h: number | null
          comments_7d: number | null
          distinct_commenters: number | null
          last_commented_at: string | null
          proposal_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "civic_comments_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_comments_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      proposal_popularity_24h: {
        Row: {
          last_viewed_at: string | null
          proposal_id: string | null
          view_count: number | null
        }
        Relationships: []
      }
      proposal_trending_24h: {
        Row: {
          comments_24h: number | null
          last_activity_at: string | null
          proposal_id: string | null
          status: Database["public"]["Enums"]["proposal_status"] | null
          title: string | null
          total_comments: number | null
          trending_score: number | null
          type: Database["public"]["Enums"]["proposal_type"] | null
        }
        Relationships: []
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      canonical_donor_fingerprint: {
        Args: { raw_name: string; zip5: string }
        Returns: string
      }
      chord_contract_flows: {
        Args: never
        Returns: {
          agency_acronym: string
          agency_id: string
          agency_name: string
          award_count: number
          sector: string
          total_cents: number
        }[]
      }
      chord_donor_brackets_for_official: {
        Args: { p_official_id: string }
        Returns: {
          bracket: string
          donor_count: number
          total_cents: number
        }[]
      }
      chord_donor_state_party_flows: {
        Args: { p_official_id?: string }
        Returns: {
          donor_state: string
          party_chamber: string
          total_usd: number
        }[]
      }
      chord_donor_type_party_flows: {
        Args: { p_official_ids?: string[] }
        Returns: {
          donor_type: string
          party_chamber: string
          total_usd: number
        }[]
      }
      chord_industry_flows: {
        Args: never
        Returns: {
          display_icon: string
          display_label: string
          donor_count: number
          industry: string
          official_count: number
          party_chamber: string
          total_cents: number
        }[]
      }
      chord_industry_flows_for_official: {
        Args: { p_official_id: string }
        Returns: {
          display_icon: string
          display_label: string
          donor_count: number
          industry: string
          total_cents: number
        }[]
      }
      chord_sector_vote_for_officials: {
        Args: { p_min_usd?: number; p_official_ids: string[] }
        Returns: {
          display_icon: string
          display_label: string
          sector: string
          total_usd: number
          vote_count: number
          vote_outcome: string
        }[]
      }
      chord_subject_party_flows: {
        Args: { p_official_ids?: string[] }
        Returns: {
          display_icon: string
          display_label: string
          party_chamber: string
          subject: string
          vote_count: number
        }[]
      }
      chord_top_pacs_for_official: {
        Args: { p_limit?: number; p_official_id: string }
        Returns: {
          display_icon: string
          display_label: string
          industry: string
          pac_id: string
          pac_name: string
          total_cents: number
        }[]
      }
      claim_enrichment_batch: {
        Args: { p_claimed_by: string; p_limit: number; p_task_type: string }
        Returns: {
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          context: Json | null
          created_at: string
          entity_id: string
          entity_type: string
          entity_updated_at: string
          id: number
          last_error: string | null
          priority: number
          result: Json | null
          retry_count: number
          status: string
          task_type: string
        }[]
        SetofOptions: {
          from: "*"
          to: "enrichment_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      compute_alignment_score: {
        Args: { p_official_id: string; p_user_id: string }
        Returns: {
          alignment_ratio: number
          matched_votes: number
          total_votes: number
          vote_details: Json
        }[]
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      enqueue_enrichment: {
        Args: {
          p_context: Json
          p_entity_id: string
          p_entity_type: string
          p_entity_updated_at?: string
          p_priority?: number
          p_task_type: string
        }
        Returns: string
      }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      find_jurisdictions_by_location: {
        Args: { user_lat: number; user_lng: number }
        Returns: {
          id: string
          name: string
          short_name: string
          type: Database["public"]["Enums"]["jurisdiction_type"]
        }[]
      }
      find_representatives_by_location: {
        Args: { user_lat: number; user_lng: number }
        Returns: {
          full_name: string
          governing_body: string
          id: string
          jurisdiction: string
          party: Database["public"]["Enums"]["party"]
          role_title: string
        }[]
      }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      get_connection_counts: {
        Args: { entity_ids: string[] }
        Returns: {
          connection_count: number
          entity_id: string
        }[]
      }
      get_crossgroup_sector_totals: {
        Args: { p_group1_ids: string[]; p_group2_ids: string[] }
        Returns: {
          group1_usd: number
          group2_usd: number
          sector: string
        }[]
      }
      get_current_usage: {
        Args: { p_metric: string; p_service: string }
        Returns: {
          recorded_at: string
          source: string
          stale_after_days: number
          value: number
          verified_at: string
        }[]
      }
      get_database_size_bytes: { Args: never; Returns: number }
      get_group_connections: {
        Args: { p_limit?: number; p_member_ids: string[] }
        Returns: {
          amount_cents: number
          connection_type: string
          from_id: string
          strength: number
          to_id: string
        }[]
      }
      get_group_sector_totals: {
        Args: { p_member_ids: string[]; p_min_usd?: number }
        Returns: {
          sector: string
          total_usd: number
        }[]
      }
      get_official_donors: {
        Args: { p_official_id: string }
        Returns: {
          entity_name: string
          entity_type: string
          financial_entity_id: string
          industry_category: string
          total_amount_usd: number
          transaction_count: number
        }[]
      }
      get_officials_breakdown: {
        Args: never
        Returns: {
          category: string
          count: number
        }[]
      }
      get_officials_by_filter: {
        Args: { p_chamber?: string; p_party?: string; p_state?: string }
        Returns: {
          id: string
        }[]
      }
      get_pac_donations_by_party: {
        Args: never
        Returns: {
          donation_count: number
          donor_name: string
          party: string
          total_usd: number
        }[]
      }
      get_pv_bots: {
        Args: never
        Returns: {
          count: number
          visitor_type: string
        }[]
      }
      get_pv_countries: {
        Args: { lim?: number }
        Returns: {
          count: number
          country_code: string
        }[]
      }
      get_pv_devices: {
        Args: never
        Returns: {
          count: number
          device_type: string
        }[]
      }
      get_pv_entry_pages: {
        Args: { days?: number; lim?: number }
        Returns: {
          page: string
          sessions: number
        }[]
      }
      get_pv_sources: {
        Args: never
        Returns: {
          referrer: string
          visits: number
        }[]
      }
      get_pv_summary: {
        Args: never
        Returns: {
          bot_views: number
          human_views: number
          total_views: number
        }[]
      }
      get_pv_top_officials: {
        Args: { lim?: number }
        Returns: {
          full_name: string
          official_id: string
          role_title: string
          views: number
        }[]
      }
      get_pv_top_pages: {
        Args: { lim?: number }
        Returns: {
          page: string
          unique_sessions: number
          views: number
        }[]
      }
      get_pv_top_proposals: {
        Args: { lim?: number }
        Returns: {
          proposal_id: string
          title: string
          views: number
        }[]
      }
      get_pv_top_transitions: {
        Args: { days?: number; lim?: number; min_count?: number }
        Returns: {
          from_page: string
          sessions: number
          to_page: string
        }[]
      }
      get_supabase_self_metrics: {
        Args: never
        Returns: {
          db_size_bytes: number
          storage_bytes: number
        }[]
      }
      gettransactionid: { Args: never; Returns: unknown }
      link_federal_reps_to_districts: { Args: never; Returns: number }
      link_officials_to_districts: { Args: never; Returns: number }
      longtransactionsenabled: { Args: never; Returns: boolean }
      normalize_pv_path: { Args: { p: string }; Returns: string }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      query_districts: {
        Args: {
          p_bbox_e?: number
          p_bbox_n?: number
          p_bbox_s?: number
          p_bbox_w?: number
          p_chamber?: string
          p_id?: string
          p_limit?: number
          p_point_lat?: number
          p_point_lng?: number
          p_simplify_tolerance?: number
          p_state?: string
        }
        Returns: {
          chamber: string
          district_id: string
          geom_geojson: string
          id: string
          name: string
          short_name: string
          state_abbr: string
        }[]
      }
      reap_stale_sync_log: {
        Args: { stale_minutes?: number }
        Returns: {
          id: string
          pipeline: string
          reaped_at: string
        }[]
      }
      rebuild_entity_connections: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_appointments: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_contracts: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_cosponsors: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_donations: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_external: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_gifts: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_holds: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_lobbying: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_oversight: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_votes: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_official_donation_totals: { Args: never; Returns: undefined }
      rebuild_official_donation_totals_full: { Args: never; Returns: undefined }
      record_enrichment_failure: {
        Args: { p_error: string; p_queue_id: number }
        Returns: string
      }
      refresh_chord_donor_state_party_flows_mv: {
        Args: never
        Returns: undefined
      }
      refresh_chord_donor_type_party_flows_mv: {
        Args: never
        Returns: undefined
      }
      refresh_chord_industry_flows_mv: { Args: never; Returns: undefined }
      refresh_chord_subject_party_flows_mv: { Args: never; Returns: undefined }
      refresh_homepage_stats_mv: { Args: never; Returns: undefined }
      refresh_official_homepage_stats_mv: { Args: never; Returns: undefined }
      refresh_pipeline_runtime_stats_mv: { Args: never; Returns: undefined }
      refresh_proposal_popularity: { Args: never; Returns: undefined }
      refresh_proposal_trending: { Args: never; Returns: undefined }
      refresh_spending_totals: { Args: never; Returns: undefined }
      search_graph_entities: {
        Args: { lim?: number; q: string }
        Returns: {
          entity_type: string
          id: string
          label: string
          party: string
          subtitle: string
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      treemap_officials_by_donations:
        | {
            Args: { lim?: number }
            Returns: {
              chamber: string
              official_id: string
              official_name: string
              party: string
              state: string
              total_donated_cents: number
            }[]
          }
        | {
            Args: {
              lim?: number
              p_chamber?: string
              p_party?: string
              p_state?: string
            }
            Returns: {
              chamber: string
              official_id: string
              official_name: string
              party: string
              state: string
              total_donated_cents: number
            }[]
          }
      treemap_recipients_by_contracts: {
        Args: { lim?: number }
        Returns: {
          award_count: number
          entity_id: string
          entity_name: string
          industry: string
          naics_code: string
          total_cents: number
        }[]
      }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
      upsert_district_jurisdiction: {
        Args: {
          p_census_geoid: string
          p_chamber: string
          p_fips_code: string
          p_geojson: string
          p_metadata: Json
          p_name: string
          p_parent_id: string
          p_short_name: string
        }
        Returns: string
      }
    }
    Enums: {
      argument_flag: "off_topic" | "misleading" | "duplicate" | "other"
      argument_side: "for" | "against"
      connection_type:
        | "donation"
        | "vote_yes"
        | "vote_no"
        | "vote_abstain"
        | "appointment"
        | "revolving_door"
        | "oversight"
        | "lobbying"
        | "co_sponsorship"
        | "family"
        | "business_partner"
        | "legal_representation"
        | "endorsement"
        | "contract_award"
        | "nomination_vote_yes"
        | "nomination_vote_no"
        | "holds_position"
        | "gift_received"
        | "member_of"
        | "owns"
        | "parent_of"
        | "affiliated_with"
      donor_type:
        | "individual"
        | "pac"
        | "super_pac"
        | "corporate"
        | "union"
        | "party_committee"
        | "small_donor_aggregate"
        | "other"
      financial_relationship_type:
        | "donation"
        | "gift"
        | "honorarium"
        | "loan"
        | "owns_stock"
        | "owns_bond"
        | "property"
        | "contract"
        | "grant"
        | "lobbying_spend"
        | "other"
        | "ie_support"
        | "ie_oppose"
      flag_content_type: "civic_comment" | "official_community_comment"
      flag_reason:
        | "spam"
        | "harassment"
        | "off_topic"
        | "misinformation"
        | "other"
      follow_entity_type: "official" | "agency"
      governing_body_type:
        | "legislature_upper"
        | "legislature_lower"
        | "legislature_unicameral"
        | "executive"
        | "judicial"
        | "regulatory_agency"
        | "municipal_council"
        | "school_board"
        | "special_district"
        | "international_body"
        | "other"
        | "committee"
      initiative_authorship: "individual" | "community"
      initiative_resolution: "sponsored" | "declined" | "withdrawn" | "expired"
      initiative_scope: "federal" | "state" | "local"
      initiative_stage:
        | "draft"
        | "deliberate"
        | "mobilise"
        | "resolved"
        | "problem"
      jurisdiction_type:
        | "global"
        | "supranational"
        | "country"
        | "state"
        | "county"
        | "city"
        | "district"
        | "precinct"
        | "other"
        | "school_district"
        | "special_district"
      notification_event_type:
        | "official_vote"
        | "new_proposal"
        | "initiative_status"
      official_response_type:
        | "support"
        | "oppose"
        | "pledge"
        | "refer"
        | "no_response"
      party:
        | "democrat"
        | "republican"
        | "independent"
        | "libertarian"
        | "green"
        | "other"
        | "nonpartisan"
      promise_status:
        | "made"
        | "in_progress"
        | "kept"
        | "broken"
        | "partially_kept"
        | "expired"
        | "modified"
      proposal_status:
        | "introduced"
        | "in_committee"
        | "passed_committee"
        | "floor_vote"
        | "passed_chamber"
        | "passed_both_chambers"
        | "signed"
        | "vetoed"
        | "veto_overridden"
        | "enacted"
        | "open_comment"
        | "comment_closed"
        | "final_rule"
        | "failed"
        | "withdrawn"
        | "tabled"
      proposal_type:
        | "bill"
        | "resolution"
        | "amendment"
        | "regulation"
        | "executive_order"
        | "treaty"
        | "referendum"
        | "initiative"
        | "budget"
        | "appointment"
        | "ordinance"
        | "other"
      signature_verification: "unverified" | "email" | "district"
    }
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      argument_flag: ["off_topic", "misleading", "duplicate", "other"],
      argument_side: ["for", "against"],
      connection_type: [
        "donation",
        "vote_yes",
        "vote_no",
        "vote_abstain",
        "appointment",
        "revolving_door",
        "oversight",
        "lobbying",
        "co_sponsorship",
        "family",
        "business_partner",
        "legal_representation",
        "endorsement",
        "contract_award",
        "nomination_vote_yes",
        "nomination_vote_no",
        "holds_position",
        "gift_received",
        "member_of",
        "owns",
        "parent_of",
        "affiliated_with",
      ],
      donor_type: [
        "individual",
        "pac",
        "super_pac",
        "corporate",
        "union",
        "party_committee",
        "small_donor_aggregate",
        "other",
      ],
      financial_relationship_type: [
        "donation",
        "gift",
        "honorarium",
        "loan",
        "owns_stock",
        "owns_bond",
        "property",
        "contract",
        "grant",
        "lobbying_spend",
        "other",
        "ie_support",
        "ie_oppose",
      ],
      flag_content_type: ["civic_comment", "official_community_comment"],
      flag_reason: [
        "spam",
        "harassment",
        "off_topic",
        "misinformation",
        "other",
      ],
      follow_entity_type: ["official", "agency"],
      governing_body_type: [
        "legislature_upper",
        "legislature_lower",
        "legislature_unicameral",
        "executive",
        "judicial",
        "regulatory_agency",
        "municipal_council",
        "school_board",
        "special_district",
        "international_body",
        "other",
        "committee",
      ],
      initiative_authorship: ["individual", "community"],
      initiative_resolution: ["sponsored", "declined", "withdrawn", "expired"],
      initiative_scope: ["federal", "state", "local"],
      initiative_stage: [
        "draft",
        "deliberate",
        "mobilise",
        "resolved",
        "problem",
      ],
      jurisdiction_type: [
        "global",
        "supranational",
        "country",
        "state",
        "county",
        "city",
        "district",
        "precinct",
        "other",
        "school_district",
        "special_district",
      ],
      notification_event_type: [
        "official_vote",
        "new_proposal",
        "initiative_status",
      ],
      official_response_type: [
        "support",
        "oppose",
        "pledge",
        "refer",
        "no_response",
      ],
      party: [
        "democrat",
        "republican",
        "independent",
        "libertarian",
        "green",
        "other",
        "nonpartisan",
      ],
      promise_status: [
        "made",
        "in_progress",
        "kept",
        "broken",
        "partially_kept",
        "expired",
        "modified",
      ],
      proposal_status: [
        "introduced",
        "in_committee",
        "passed_committee",
        "floor_vote",
        "passed_chamber",
        "passed_both_chambers",
        "signed",
        "vetoed",
        "veto_overridden",
        "enacted",
        "open_comment",
        "comment_closed",
        "final_rule",
        "failed",
        "withdrawn",
        "tabled",
      ],
      proposal_type: [
        "bill",
        "resolution",
        "amendment",
        "regulation",
        "executive_order",
        "treaty",
        "referendum",
        "initiative",
        "budget",
        "appointment",
        "ordinance",
        "other",
      ],
      signature_verification: ["unverified", "email", "district"],
    },
  },
} as const

